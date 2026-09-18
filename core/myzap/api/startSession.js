const Store = require('electron-store');
const store = new Store();
const { warn, error, debug } = require('../myzapLogger');
const { getMyZapApiBaseUrls } = require('./requestMyZapApi');
const { getBackendApiConfig } = require('../capabilities');

const REQUEST_TIMEOUT_MS = 8000;

/**
 * Pega no backend a URL do webhook de ACK, para o MyZap mandar entregue/lido
 * direto ao backend. Best-effort: qualquer falha -> '' (a sessao sobe sem
 * webhook e o disparo segue normal; so nao havera entregue/lido).
 *
 * ESTA CHAMADA IA SEM CREDENCIAL NENHUMA — e /config e rota PRIVADA.
 *
 * O autoConfig busca a MESMA rota com `Authorization: Bearer`, mas aqui so ia
 * `Accept`. Resultado: 401 em toda tentativa, `wh_message` nunca era gravado na
 * sessao do motor e a confirmacao de entrega/leitura NUNCA chegava — para
 * nenhuma loja, nem as que estavam funcionando. Como a funcao e best-effort e
 * loga em `debug`, a falha era silenciosa: o painel mostrava "Entregues hoje 0"
 * sem nada explicando por que.
 *
 * O token e o mesmo que o resto do app usa para falar com o backend
 * (getBackendApiConfig), que e o valor do campo "Token de acesso".
 */
async function obterAckWebhookUrl() {
    try {
        const { backendApiUrl, backendApiToken } = getBackendApiConfig(store);
        const idempresa = String(store.get('idempresa') || '').trim();
        if (!backendApiUrl || !idempresa) {
            return '';
        }
        const base = backendApiUrl.endsWith('/') ? backendApiUrl : backendApiUrl + '/';
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
        try {
            const headers = { Accept: 'application/json' };
            if (backendApiToken) {
                headers.Authorization = `Bearer ${backendApiToken}`;
            }
            const res = await fetch(`${base}parametrizacao-myzap/config/${encodeURIComponent(idempresa)}`, {
                method: 'GET',
                headers,
                signal: ctrl.signal
            });
            if (!res.ok) {
                // 401/403 aqui e configuracao, nao indisponibilidade: sem log,
                // "o ACK nao chega" fica indistinguivel de "o motor nao reportou".
                warn('Backend recusou a busca do ack_webhook_url (seguindo sem webhook)', {
                    metadata: { area: 'startSession', status: res.status, temToken: !!backendApiToken }
                });
                return '';
            }
            const data = await res.json();
            const url = data && data.result && data.result.ack_webhook_url;
            return typeof url === 'string' ? url.trim() : '';
        } finally {
            clearTimeout(timer);
        }
    } catch (e) {
        debug('Falha ao obter ack_webhook_url (seguindo sem webhook)', {
            metadata: { area: 'startSession', error: (e && e.message) || String(e) }
        });
        return '';
    }
}

async function startSession() {
    const token = store.get('myzap_apiToken');
    // 127.0.0.1 primeiro e localhost como fallback (lista vem do helper robusto)
    const baseUrls = getMyZapApiBaseUrls();
    const session = store.get('myzap_sessionKey');
    const sessionName = store.get('myzap_sessionName') || session;

    if (!token) {
        warn('Token nao encontrado ao iniciar sessao', {
            metadata: { area: 'startSession', missing: 'token' }
        });
        return null;
    }

    if (!session) {
        warn('Session key nao encontrada ao iniciar sessao', {
            metadata: { area: 'startSession', missing: 'session' }
        });
        return null;
    }

    // URL do webhook de ACK (entregue/lido) que o MyZap deve chamar. Buscada 1x.
    const whMessage = await obterAckWebhookUrl();
    if (whMessage) {
        debug('Webhook de ACK sera configurado na sessao MyZap', {
            metadata: { area: 'startSession', session }
        });
    }

    let lastError = null;

    for (const api of baseUrls) {
        // AbortController + timeout para nao travar quando o MyZap local nao responde
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
        try {
            debug('Iniciando sessao MyZap', {
                metadata: { area: 'startSession', session, sessionName, api }
            });

            const res = await fetch(api + 'start', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    apitoken: token,
                    sessionkey: session
                },
                body: JSON.stringify({
                    session,
                    sessionName: sessionName || session,
                    waitQrCode: true,
                    // MyZap grava como webhook de mensagens (wh_message) e passa a
                    // mandar os ACKs (entregue/lido) para o DisparaZap.
                    ...(whMessage ? { wh_message: whMessage } : {})
                }),
                signal: ctrl.signal
            });

            // Nao tratar 401/403/500 com corpo JSON como sucesso
            if (!res.ok) {
                if (res.status === 401 || res.status === 403) {
                    error('Credencial recusada ao iniciar sessao MyZap (start)', {
                        metadata: { area: 'startSession', api, httpStatus: res.status }
                    });
                } else {
                    warn('Resposta HTTP de erro ao iniciar sessao MyZap', {
                        metadata: { area: 'startSession', api, httpStatus: res.status }
                    });
                }
                return null;
            }

            const data = await res.json();
            debug('Resposta startSession', {
                metadata: { area: 'startSession', status: res.status, data }
            });
            return data;

        } catch (e) {
            lastError = e;
            warn('Falha ao iniciar sessao MyZap', {
                metadata: { area: 'startSession', api, error: (e && e.message) || String(e) }
            });
        } finally {
            clearTimeout(timer);
        }
    }

    error('Erro ao iniciar sessao MyZap (todas as URLs falharam)', {
        metadata: { area: 'startSession', error: (lastError && lastError.message) || String(lastError) }
    });
    return null;
}

module.exports = startSession;
