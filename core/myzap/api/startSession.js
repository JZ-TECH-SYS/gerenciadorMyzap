const Store = require('electron-store');
const store = new Store();
const { warn, error, debug } = require('../myzapLogger');
const { getMyZapApiBaseUrls } = require('./requestMyZapApi');

const REQUEST_TIMEOUT_MS = 8000;

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
                    waitQrCode: true
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
