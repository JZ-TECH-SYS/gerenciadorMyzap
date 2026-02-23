const Store = require("electron-store");
const store = new Store();
const { warn, error, debug } = require('../myzapLogger');

async function verifyRealStatus() {
    const token = store.get('myzap_apiToken');
    const api = "http://localhost:5555/";
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

    try {
        debug("Verificando status real MyZap", {
            metadata: { area: 'verifyRealStatus', session }
        });

        const res = await fetch(`${api}verifyRealStatus`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                apitoken: token,
                sessionkey: session
            },
            body: JSON.stringify({ session })
        });

        const data = await res.json();
        return data;

    } catch (e) {
        error("Erro ao verificar status real MyZap", {
            metadata: { area: 'verifyRealStatus', error: e }
        });
        return null;
    }
}

module.exports = verifyRealStatus;
