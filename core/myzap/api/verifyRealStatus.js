const Store = require("electron-store");
const store = new Store();
const { warn, error, debug } = require('../myzapLogger');
const { getMyZapApiBaseUrls } = require('./requestMyZapApi');

const REQUEST_TIMEOUT_MS = 8000;

async function verifyRealStatus() {
    const token = store.get('myzap_apiToken');
    // 127.0.0.1 primeiro e localhost como fallback (lista vem do helper robusto)
    const baseUrls = getMyZapApiBaseUrls();
    const session = store.get("myzap_sessionKey");

    if (!token) {
        warn("Token não encontrado", {
            metadata: { area: 'verifyRealStatus', missing: 'token' }
        });
        return null;
    }

    if (!session) {
        warn("Session não encontrada", {
            metadata: { area: 'verifyRealStatus', missing: 'session' }
        });
        return null;
    }

    let lastError = null;

    for (const api of baseUrls) {
        // AbortController + timeout para nao travar quando o MyZap local nao responde
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
        try {
            debug("Verificando status real MyZap", {
                metadata: { area: 'verifyRealStatus', session, api }
            });

            const res = await fetch(`${api}verifyRealStatus`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    apitoken: token,
                    sessionkey: session
                },
                body: JSON.stringify({ session }),
                signal: ctrl.signal
            });

            if (!res.ok) {
                if (res.status === 401 || res.status === 403) {
                    error("Credencial recusada ao verificar status real MyZap (verifyRealStatus)", {
                        metadata: { area: 'verifyRealStatus', api, httpStatus: res.status }
                    });
                    return null;
                }

                // O MyZap moderno responde erros com JSON util — ex.: HTTP 404
                // {"status":"NOT FOUND","messages":"A session (x) informada nao
                // existe."} quando a sessao ainda nao foi criada. Isso e
                // INFORMACAO (painel mostra "Sessao nao iniciada"), nao erro.
                const body = await res.json().catch(() => null);
                if (body && typeof body === 'object') {
                    debug("Status HTTP de erro com corpo util no verifyRealStatus", {
                        metadata: { area: 'verifyRealStatus', api, httpStatus: res.status, body }
                    });
                    return body;
                }

                warn("Resposta HTTP de erro ao verificar status real MyZap", {
                    metadata: { area: 'verifyRealStatus', api, httpStatus: res.status }
                });
                return null;
            }

            const data = await res.json();
            return data;

        } catch (e) {
            lastError = e;
            warn("Falha ao verificar status real MyZap", {
                metadata: { area: 'verifyRealStatus', api, error: (e && e.message) || String(e) }
            });
        } finally {
            clearTimeout(timer);
        }
    }

    error("Erro ao verificar status real MyZap (todas as URLs falharam)", {
        metadata: { area: 'verifyRealStatus', error: (lastError && lastError.message) || String(lastError) }
    });
    return null;
}

module.exports = verifyRealStatus;
