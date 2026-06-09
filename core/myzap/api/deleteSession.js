const Store = require("electron-store");
const store = new Store();
const { warn, error, debug } = require('../myzapLogger');
const { getMyZapApiBaseUrls } = require('./requestMyZapApi');

const REQUEST_TIMEOUT_MS = 8000;

async function deleteSession() {
    const token = store.get('myzap_apiToken');
    // 127.0.0.1 primeiro e localhost como fallback (lista vem do helper robusto)
    const baseUrls = getMyZapApiBaseUrls();
    const session = store.get("myzap_sessionKey");

    if (!token) {
        warn("Token não encontrado", {
            metadata: { area: 'deleteSession', missing: 'token' }
        });
        return null;
    }

    if (!session) {
        warn("Session não encontrada", {
            metadata: { area: 'deleteSession', missing: 'session' }
        });
        return null;
    }

    let lastError = null;

    for (const api of baseUrls) {
        // AbortController + timeout para nao travar quando o MyZap local nao responde
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
        try {
            debug("Encerrando sessão MyZap", {
                metadata: { area: 'deleteSession', session, api }
            });

            const res = await fetch(`${api}deleteSession`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    apitoken: token,
                    sessionkey: session
                },
                body: JSON.stringify({ session }),
                signal: ctrl.signal
            });

            // Nao tratar 401/403/500 com corpo JSON como sucesso
            if (!res.ok) {
                if (res.status === 401 || res.status === 403) {
                    error("Credencial recusada ao deletar sessão MyZap (deleteSession)", {
                        metadata: { area: 'deleteSession', api, httpStatus: res.status }
                    });
                } else {
                    warn("Resposta HTTP de erro ao deletar sessão MyZap", {
                        metadata: { area: 'deleteSession', api, httpStatus: res.status }
                    });
                }
                return null;
            }

            const data = await res.json();
            return data;

        } catch (e) {
            lastError = e;
            warn("Falha ao deletar sessão MyZap", {
                metadata: { area: 'deleteSession', api, error: (e && e.message) || String(e) }
            });
        } finally {
            clearTimeout(timer);
        }
    }

    error("Erro ao deletar sessão MyZap (todas as URLs falharam)", {
        metadata: { area: 'deleteSession', error: (lastError && lastError.message) || String(lastError) }
    });
    return null;
}

module.exports = deleteSession;
