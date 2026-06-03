const Store = require("electron-store");
const store = new Store();
const { warn, error, debug } = require('../myzapLogger');

async function deleteSession() {
    const token = store.get('myzap_apiToken');
    const api = "http://localhost:5555/";
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

    try {
        debug("Encerrando sessão MyZap", {
            metadata: { area: 'deleteSession', session }
        });

        const res = await fetch(`${api}deleteSession`, {
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
        error("Erro ao deletar sessão MyZap", {
            metadata: { area: 'deleteSession', error: e }
        });
        return null;
    }
}

module.exports = deleteSession;
