const Store = require('electron-store');
const { info, warn, error } = require('../utils/logger');

const store = new Store();
const MYZAP_API_URL = 'http://localhost:5555/';
const LOOP_INTERVAL_MS = 30000;

let ativo = false;
let processando = false;
let timer = null;
let ultimaExecucaoEm = null;
let ultimoErro = null;
let ultimoLote = 0;
let ultimosPendentes = [];

function normalizeBaseUrl(url) {
  if (!url || typeof url !== 'string') return '';
  return url.endsWith('/') ? url : `${url}/`;
}

async function validarDisponibilidadeMyZap(sessionKey, sessionToken) {
  try {
    console.log('[FilaMyZap] Validando disponibilidade do MyZap (/verifyRealStatus)...', { sessionKey });

    const res = await fetch(`${MYZAP_API_URL}verifyRealStatus`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apitoken: sessionToken,
        sessionkey: sessionKey
      },
      body: JSON.stringify({ session: sessionKey })
    });

    const data = await res.json().catch(() => ({}));
    console.log('[FilaMyZap] Retorno verifyRealStatus:', { status: res.status, data });
    return res.ok;
  } catch (err) {
    console.log('[FilaMyZap] Erro ao validar disponibilidade do MyZap:', err?.message || err);
    return false;
  }
}

async function buscarPendentes(apiBaseUrl, token, sessionKey, sessionToken) {
  const query = new URLSearchParams({
    sessionKey: sessionKey || '',
    sessionToken: sessionToken || ''
  }).toString();

  console.log('[FilaMyZap] Buscando pendentes...', { apiBaseUrl, sessionKey });

  const res = await fetch(`${apiBaseUrl}parametrizacao-myzap/pendentes?${query}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` }
  });

  const data = await res.json().catch(() => ({}));
  console.log('[FilaMyZap] Retorno /parametrizacao-myzap/pendentes:', {
    status: res.status,
    total: data?.result?.total,
    error: data?.error
  });

  if (!res.ok || data?.error) {
    throw new Error(data?.error || 'Falha ao consultar pendentes');
  }

  return Array.isArray(data?.result?.mensagens) ? data.result.mensagens : [];
}

async function atualizarStatusFila(apiBaseUrl, token, payload) {
  console.log('[FilaMyZap] Atualizando status da fila...', payload);

  const res = await fetch(`${apiBaseUrl}parametrizacao-myzap/fila/status`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json().catch(() => ({}));
  console.log('[FilaMyZap] Retorno /parametrizacao-myzap/fila/status:', { status: res.status, data });
  return res.ok && !data?.error;
}

async function enviarParaMyZap(mensagem, fallbackSessionKey, fallbackApiToken) {
  if (String(mensagem?.status || '').toLowerCase() === 'enviado') {
    return { ok: true, skipped: true, motivo: 'status_enviado' };
  }

  let payloadFila = {};
  try {
    payloadFila = mensagem?.json ? JSON.parse(mensagem.json) : {};
  } catch (e) {
    return { ok: false, erro: `JSON inválido da fila: ${e.message}` };
  }

  const endpoint = payloadFila?.endpoint;
  const data = payloadFila?.data;

  if (!endpoint || !data) {
    return { ok: false, erro: 'Mensagem sem endpoint ou payload para MyZap' };
  }

  const endpointNormalizado = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
  const sessionKey = mensagem?.sessionkey || fallbackSessionKey;
  const apiToken = mensagem?.apitoken || fallbackApiToken;

  if (!sessionKey || !apiToken) {
    return { ok: false, erro: 'SessionKey ou APIToken do MyZap ausente' };
  }

  console.log('[FilaMyZap] Enviando para MyZap...', {
    idfila: mensagem?.idfila,
    endpoint: endpointNormalizado,
    sessionKey
  });

  const res = await fetch(`${MYZAP_API_URL}${endpointNormalizado}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apitoken: apiToken,
      sessionkey: sessionKey
    },
    body: JSON.stringify(data)
  });

  const body = await res.json().catch(() => ({}));
  console.log('[FilaMyZap] Retorno MyZap:', { idfila: mensagem?.idfila, status: res.status, body });

  if (!res.ok || body?.error) {
    return { ok: false, erro: body?.error || `HTTP ${res.status}` };
  }

  if (endpointNormalizado.toLowerCase() === 'sendtext' && body?.result !== 200) {
    return { ok: false, erro: 'Retorno do sendText diferente de 200' };
  }

  return { ok: true, body };
}

async function obterCredenciaisAtivas() {
  const clickApiUrl = normalizeBaseUrl(String(store.get('clickexpress_apiUrl') || '').trim());
  const clickToken = String(store.get('clickexpress_queueToken') || '').trim();
  const sessionKey = String(store.get('myzap_sessionKey') || '').trim();
  const sessionToken = String(store.get('myzap_apiToken') || '').trim();
  return { clickApiUrl, clickToken, sessionKey, sessionToken };
}

async function listarPendentesMyZap() {
  const { clickApiUrl, clickToken, sessionKey, sessionToken } = await obterCredenciaisAtivas();

  if (!clickApiUrl || !clickToken || !sessionKey || !sessionToken) {
    return [];
  }

  return buscarPendentes(clickApiUrl, clickToken, sessionKey, sessionToken);
}

async function processarFilaUmaRodada() {
  if (!ativo || processando) return;
  processando = true;

  try {
    const pendentes = await listarPendentesMyZap();
    ultimosPendentes = Array.isArray(pendentes) ? pendentes : [];
    const lote = pendentes.filter((m) => String(m?.status || '').toLowerCase() !== 'enviado');

    ultimoLote = lote.length;
    ultimaExecucaoEm = new Date().toISOString();

    if (lote.length > 0) {
      info('Processando lote da fila MyZap', {
        metadata: { totalPendentes: pendentes.length, tamanhoLote: lote.length }
      });
    }

    const { clickApiUrl, clickToken, sessionKey, sessionToken } = await obterCredenciaisAtivas();

    for (const mensagem of lote) {
      if (!ativo) break;

      let novoStatus = 'erro';
      try {
        const envio = await enviarParaMyZap(mensagem, sessionKey, sessionToken);
        novoStatus = envio.ok ? 'enviado' : 'erro';

        if (!envio.ok) {
          warn('Falha ao enviar mensagem para MyZap', {
            metadata: {
              idfila: mensagem?.idfila,
              idempresa: mensagem?.idempresa,
              motivo: envio?.erro || envio?.motivo
            }
          });
        }
      } catch (envioError) {
        warn('Erro inesperado no envio para MyZap', {
          metadata: {
            idfila: mensagem?.idfila,
            idempresa: mensagem?.idempresa,
            error: envioError
          }
        });
      }

      const statusOk = await atualizarStatusFila(clickApiUrl, clickToken, {
        idfila: mensagem?.idfila,
        idempresa: mensagem?.idempresa,
        status: novoStatus
      });

      if (!statusOk) {
        warn('Não foi possível atualizar status da fila MyZap', {
          metadata: {
            idfila: mensagem?.idfila,
            idempresa: mensagem?.idempresa,
            status: novoStatus
          }
        });
      }
    }

    ultimoErro = null;
  } catch (e) {
    ultimoErro = e?.message || String(e);
    error('Erro no watcher da fila MyZap', {
      metadata: { area: 'whatsappQueueWatcher', error: e }
    });
  } finally {
    processando = false;
  }
}

async function startWhatsappQueueWatcher() {
  if (ativo) {
    return { status: 'success', message: 'Watcher da fila MyZap já está em execução.' };
  }

  const config = await obterCredenciaisAtivas();
  if (!config.clickApiUrl || !config.clickToken || !config.sessionKey || !config.sessionToken) {
    console.log('[FilaMyZap] Configuração incompleta para iniciar watcher.', config);
    return { status: 'error', message: 'Configuração do ClickExpress/MyZap incompleta.' };
  }

  const myzapDisponivel = await validarDisponibilidadeMyZap(config.sessionKey, config.sessionToken);
  if (!myzapDisponivel) {
    return {
      status: 'error',
      message: 'MyZap indisponível. Verifique se a sessão está ativa antes de iniciar a fila.'
    };
  }

  ativo = true;
  ultimoErro = null;

  info('Iniciando watcher da fila MyZap', {
    metadata: { area: 'whatsappQueueWatcher', loopMs: LOOP_INTERVAL_MS }
  });

  timer = setInterval(() => {
    console.log('[FilaMyZap] Tick de processamento da fila.');
    processarFilaUmaRodada().catch((err) => {
      error('Erro inesperado no loop da fila MyZap', {
        metadata: { area: 'whatsappQueueWatcher', error: err }
      });
    });
  }, LOOP_INTERVAL_MS);

  await processarFilaUmaRodada();
  return { status: 'success', message: 'Watcher da fila MyZap iniciado com sucesso.' };
}

function stopWhatsappQueueWatcher() {
  if (!ativo && !timer) {
    return { status: 'success', message: 'Watcher da fila MyZap já estava parado.' };
  }

  if (timer) {
    clearInterval(timer);
    timer = null;
  }

  ativo = false;
  processando = false;

  info('Watcher da fila MyZap parado', { metadata: { area: 'whatsappQueueWatcher' } });

  return { status: 'success', message: 'Watcher da fila MyZap parado com sucesso.' };
}

function getWhatsappQueueWatcherStatus() {
  const proximaExecucaoEm = ultimaExecucaoEm
    ? new Date(new Date(ultimaExecucaoEm).getTime() + LOOP_INTERVAL_MS).toISOString()
    : null;

  return {
    ativo,
    processando,
    ultimoLote,
    ultimaExecucaoEm,
    proximaExecucaoEm,
    loopIntervalMs: LOOP_INTERVAL_MS,
    ultimoErro
  };
}

function getUltimosPendentesMyZap() {
  return Array.isArray(ultimosPendentes) ? [...ultimosPendentes] : [];
}

module.exports = {
  listarPendentesMyZap,
  getUltimosPendentesMyZap,
  startWhatsappQueueWatcher,
  stopWhatsappQueueWatcher,
  getWhatsappQueueWatcherStatus
};
