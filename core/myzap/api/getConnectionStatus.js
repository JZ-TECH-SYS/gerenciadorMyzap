const Store = require("electron-store");
const store = new Store();
const { warn, error, debug } = require('../myzapLogger');
const { getMyZapApiBaseUrls } = require('./requestMyZapApi');

const REQUEST_TIMEOUT_MS = 8000;

async function getConnectionStatus() {
    const token = store.get('myzap_apiToken');
    // 127.0.0.1 primeiro e localhost como fallback (lista vem do helper robusto)
    const baseUrls = getMyZapApiBaseUrls();
    const session = store.get("myzap_sessionKey");

    if (!token) {
        warn("Token não encontrado", {
            metadata: { area: 'getConnectionStatus', missing: 'token' }
        });
        return [];
    }

    if (!session) {
        warn("Session da API não encontrada", {
            metadata: { area: 'getConnectionStatus', missing: 'apiUrl' }
        });
        return [];
    }

    let lastError = null;

    for (const api of baseUrls) {
        // AbortController + timeout para nao travar quando o MyZap local nao responde
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
        try {
            debug("Consultando status de conexão MyZap", {
                metadata: { area: 'getConnectionStatus', session, api }
            });

            const res = await fetch(`${api}getConnectionStatus`, {
                method: "POST",
                body: JSON.stringify({ session }),
                headers: {
                    "Content-Type": "application/json",
                    apitoken: token,
                    sessionkey: session
                },
                signal: ctrl.signal
            });

            // Nao tratar 401/403/500 com corpo JSON como sucesso (preserva shape: [])
            if (!res.ok) {
                if (res.status === 401 || res.status === 403) {
                    error("Credencial recusada ao consultar status de conexão MyZap (getConnectionStatus)", {
                        metadata: { area: 'getConnectionStatus', api, httpStatus: res.status }
                    });
                } else {
                    warn("Resposta HTTP de erro ao consultar status de conexão MyZap", {
                        metadata: { area: 'getConnectionStatus', api, httpStatus: res.status }
                    });
                }
                return [];
            }

            const data = await res.json();
            return data;

        } catch (e) {
            lastError = e;
            warn("Falha ao consultar status de conexão MyZap", {
                metadata: { area: 'getConnectionStatus', api, error: (e && e.message) || String(e) }
            });
        } finally {
            clearTimeout(timer);
        }
    }

    error("Erro ao consultar API (todas as URLs falharam)", {
        metadata: { area: 'getConnectionStatus', error: (lastError && lastError.message) || String(lastError) }
    });
    return [];
}

module.exports = getConnectionStatus;
