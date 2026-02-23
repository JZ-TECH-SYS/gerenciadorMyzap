const Store = require('electron-store');
const store = new Store();
const { warn, error, debug } = require('../myzapLogger');

async function startSession() {
    const token = store.get('myzap_apiToken');
    const api = 'http://localhost:5555/';
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

    try {
        debug('Iniciando sessao MyZap', {
            metadata: { area: 'startSession', session, sessionName }
        });

        const res = await fetch(api + 'start', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                apitoken: token,
                sessionkey: session
            },
            body: JSON.stringify({ session, sessionName: sessionName || session })
        });

        const data = await res.json();
        debug('Resposta startSession', {
            metadata: { area: 'startSession', status: res.status, data }
        });
        return data;

    } catch (e) {
        error('Erro ao iniciar sessao MyZap', {
            metadata: { area: 'startSession', error: (e && e.message) || String(e) }
        });
        return null;
    }
}

module.exports = startSession;
