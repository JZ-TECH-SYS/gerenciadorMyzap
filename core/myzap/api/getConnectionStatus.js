const Store = require("electron-store");
const store = new Store();
const { warn, error, debug } = require('../myzapLogger');

async function getConnectionStatus() {
    const token = store.get('myzap_apiToken');
    const api = "http://localhost:5555/";
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

    try {
        const res = await fetch(`${api}getConnectionStatus`, {
            method: "POST",
            body: JSON.stringify({ session }),
            headers: {
                "Content-Type": "application/json",
                apitoken: token,
                sessionkey: session
            }
        });
        const data = await res.json();
        return data;

    } catch (e) {
        error("Erro ao consultar API", {
            metadata: { area: 'getConnectionStatus', error: e }
        });
        return [];
    }
}

module.exports = getConnectionStatus;
