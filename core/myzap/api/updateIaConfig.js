const Store = require('electron-store');
const store = new Store();
const { warn, error, debug } = require('../../utils/logger');

async function updateIaConfig(mensagemPadrao) {
  const token = store.get('myzap_apiToken');
  const api = 'http://localhost:5555/';
  const session = store.get('myzap_sessionKey');

  if (!token) {
    warn('Token não encontrado', {
      metadata: { area: 'updateIaConfig', missing: 'token' }
    });
    return null;
  }

  if (!session) {
    warn('Session não encontrada', {
      metadata: { area: 'updateIaConfig', missing: 'session' }
    });
    return null;
  }

  try {
    debug('Atualizando configuração de IA MyZap', {
      metadata: { area: 'updateIaConfig', session }
    });

    const payload = {
      session,
      sessionkey: session,
      mensagem_padrao: mensagemPadrao,
      api_url: null
    };

    const res = await fetch(`${api}admin/ia-manager/update-config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apitoken: token,
        sessionkey: session
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (res.ok) {
      store.set('myzap_mensagemPadrao', mensagemPadrao);
    }

    return data;
  } catch (e) {
    error('Erro ao atualizar configuração de IA MyZap', {
      metadata: { area: 'updateIaConfig', error: e }
    });
    return null;
  }
}

module.exports = updateIaConfig;
