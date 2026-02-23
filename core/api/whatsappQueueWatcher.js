const Store = require('electron-store');
const { info, warn, error, debug } = require('../myzap/myzapLogger');

const store = new Store();
const MYZAP_API_URL = 'http://localhost:5555/';
const LOOP_INTERVAL_MS = 3000;
const FETCH_TIMEOUT_MS = 15000;
const PROCESSANDO_TIMEOUT_MS = 120000;

let ativo = false;
let processando = false;
let processandoDesde = 0;
let timer = null;
let ultimaExecucaoEm = null;
let ultimoErro = null;
let ultimoLote = 0;
let ultimosPendentes = [];
let consecutiveSkips = 0;
const MAX_CONSECUTIVE_SKIPS = 10;
const SKIP_LOG_EVERY = 5;

function normalizeBaseUrl(url) {
  if (!url || typeof url !== 'string') return '';
  return url.endsWith('/') ? url : `${url}/`;
}

async function validarDisponibilidadeMyZap(sessionKey, sessionToken) {
  try {
    debug('[FilaMyZap] Validando disponibilidade do MyZap (/verifyRealStatus)...', {
      metadata: { sessionKey }
    });

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(`${MYZAP_API_URL}verifyRealStatus`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apitoken: sessionToken,
        sessionkey: sessionKey
      },
      body: JSON.stringify({ session: sessionKey }),
      signal: ctrl.signal
    });

    clearTimeout(timeout);

    const data = await res.json().catch(() => ({}));
    debug('[FilaMyZap] Retorno verifyRealStatus', { metadata: { status: res.status, data } });
    return res.ok;
  } catch (err) {
    warn('[FilaMyZap] Erro ao validar disponibilidade do MyZap', {
      metadata: { error: err?.message || err }
    });
    return false;
  }
}

async function buscarPendentes(apiBaseUrl, token, sessionKey, sessionName) {
  const query = new URLSearchParams({
    sessionKey: sessionKey || '',
    sessionToken: sessionName || ''
  }).toString();

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  debug('[FilaMyZap] Buscando pendentes', { metadata: { apiBaseUrl, sessionKey, sessionName, query } });
  const res = await fetch(`${apiBaseUrl}parametrizacao-myzap/pendentes?${query}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    signal: ctrl.signal
  });

  clearTimeout(timeout);

  const data = await res.json().catch(() => ({}));
  debug('[FilaMyZap] Retorno /parametrizacao-myzap/pendentes', {
    metadata: {
      status: res.status,
      total: data?.result?.total,
      error: data?.error
    }
  });
  if (!res.ok || data?.error) {
    throw new Error(data?.error || 'Falha ao consultar pendentes');
  }

  return Array.isArray(data?.result?.mensagens) ? data.result.mensagens : [];
}

async function atualizarStatusFila(apiBaseUrl, token, payload) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  debug('[FilaMyZap] Atualizando status da fila', { metadata: payload });
  const res = await fetch(`${apiBaseUrl}parametrizacao-myzap/fila/status`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(payload),
    signal: ctrl.signal
  });

  clearTimeout(timeout);

  const data = await res.json().catch(() => ({}));
  debug('[FilaMyZap] Retorno /parametrizacao-myzap/fila/status', {
    metadata: { status: res.status, data }
  });
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
    return { ok: false, erro: `JSON invalido da fila: ${e.message}` };
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

  debug('[FilaMyZap] Enviando para MyZap', {
    metadata: {
      idfila: mensagem?.idfila,
      endpoint: endpointNormalizado,
      sessionKey
    }
  });

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  const res = await fetch(`${MYZAP_API_URL}${endpointNormalizado}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apitoken: apiToken,
      sessionkey: sessionKey
    },
    body: JSON.stringify(data),
    signal: ctrl.signal
  });

  clearTimeout(timeout);

  const body = await res.json().catch(() => ({}));
  debug('[FilaMyZap] Retorno MyZap', {
    metadata: {
      idfila: mensagem?.idfila,
      status: res.status,
      body
    }
  });
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
  const sessionName = String(store.get('myzap_sessionName') || sessionKey).trim();
  const myzapApiToken = String(store.get('myzap_apiToken') || '').trim();

  return {
    clickApiUrl,
    clickToken,
    sessionKey,
    sessionName,
    myzapApiToken
  };
}

async function listarPendentesMyZap() {
  const config = await obterCredenciaisAtivas();
  const {
    clickApiUrl,
    clickToken,
    sessionKey,
    sessionName
  } = config;

  if (!clickApiUrl || !clickToken || !sessionKey || !sessionName) {
    return [];
  }

  return buscarPendentes(clickApiUrl, clickToken, sessionKey, sessionName);
}

async function processarFilaUmaRodada() {
  if (!ativo) return;

  // Protecao contra processamento travado (timeout de seguranca)
  if (processando) {
    const elapsed = Date.now() - processandoDesde;
    if (elapsed > PROCESSANDO_TIMEOUT_MS) {
      warn('[FilaMyZap] Processamento anterior travado, resetando flag processando', {
        metadata: { area: 'whatsappQueueWatcher', elapsedMs: elapsed }
      });
      processando = false;
    } else {
      return;
    }
  }

  processando = true;
  processandoDesde = Date.now();

  info('[FilaMyZap] Iniciando ciclo de processamento da fila', {
    metadata: { area: 'whatsappQueueWatcher' }
  });

  try {
    // Validar MyZap disponivel antes de buscar pendentes
    const configAtual = await obterCredenciaisAtivas();
    if (!configAtual.sessionKey || !configAtual.myzapApiToken) {
      consecutiveSkips++;
      if (consecutiveSkips % SKIP_LOG_EVERY === 1) {
        warn(`[FilaMyZap] Credenciais ausentes (skip #${consecutiveSkips})`, {
          metadata: { consecutiveSkips }
        });
      }
      if (consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) {
        warn(`[FilaMyZap] Auto-stop: ${MAX_CONSECUTIVE_SKIPS} skips consecutivos`, {
          metadata: { area: 'whatsappQueueWatcher' }
        });
        stopWhatsappQueueWatcher();
      }
      return;
    }

    const myzapOk = await validarDisponibilidadeMyZap(configAtual.sessionKey, configAtual.myzapApiToken);
    if (!myzapOk) {
      consecutiveSkips++;
      if (consecutiveSkips % SKIP_LOG_EVERY === 1) {
        warn(`[FilaMyZap] MyZap indisponivel (skip #${consecutiveSkips})`, {
          metadata: { consecutiveSkips }
        });
      }
      if (consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) {
        warn(`[FilaMyZap] Auto-stop: ${MAX_CONSECUTIVE_SKIPS} skips consecutivos (MyZap down)`, {
          metadata: { area: 'whatsappQueueWatcher' }
        });
        stopWhatsappQueueWatcher();
      }
      return;
    }

    // MyZap ok, reset skip counter
    consecutiveSkips = 0;

    const pendentes = await listarPendentesMyZap();
    ultimosPendentes = Array.isArray(pendentes) ? pendentes : [];
    const lote = pendentes.filter((m) => String(m?.status || '').toLowerCase() !== 'enviado');

    ultimoLote = lote.length;
    ultimaExecucaoEm = new Date().toISOString();

    info('[FilaMyZap] Busca de pendentes concluida', {
      metadata: { totalPendentes: pendentes.length, tamanhoLote: lote.length }
    });

    if (lote.length === 0) {
      info('[FilaMyZap] Nenhuma mensagem pendente para envio neste ciclo', {
        metadata: { area: 'whatsappQueueWatcher' }
      });
    }

    const {
      clickApiUrl,
      clickToken,
      sessionKey,
      myzapApiToken
    } = await obterCredenciaisAtivas();

    for (const mensagem of lote) {
      if (!ativo) break;

      let novoStatus = 'erro';
      try {
        info('[FilaMyZap] Enviando mensagem', {
          metadata: { idfila: mensagem?.idfila, idempresa: mensagem?.idempresa }
        });

        const envio = await enviarParaMyZap(mensagem, sessionKey, myzapApiToken);
        novoStatus = envio.ok ? 'enviado' : 'erro';

        if (envio.ok) {
          info('[FilaMyZap] Mensagem enviada com sucesso', {
            metadata: { idfila: mensagem?.idfila, idempresa: mensagem?.idempresa }
          });
        } else {
          warn('[FilaMyZap] Falha ao enviar mensagem para MyZap', {
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
        warn('Nao foi possivel atualizar status da fila MyZap', {
          metadata: {
            idfila: mensagem?.idfila,
            idempresa: mensagem?.idempresa,
            status: novoStatus
          }
        });
      }
    }

    info('[FilaMyZap] Ciclo de processamento concluido', {
      metadata: { area: 'whatsappQueueWatcher', loteProcessado: lote.length }
    });

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
    return { status: 'success', message: 'Watcher da fila MyZap ja esta em execucao.' };
  }

  const config = await obterCredenciaisAtivas();
  if (!config.clickApiUrl || !config.clickToken || !config.sessionKey || !config.myzapApiToken) {
    warn('[FilaMyZap] Configuracao incompleta para iniciar watcher', {
      metadata: {
        clickApiUrl: !!config.clickApiUrl,
        clickToken: !!config.clickToken,
        sessionKey: !!config.sessionKey,
        sessionName: !!config.sessionName,
        myzapApiToken: !!config.myzapApiToken
      }
    });
    return { status: 'error', message: 'Configuracao do ClickExpress/MyZap incompleta.' };
  }

  const myzapDisponivel = await validarDisponibilidadeMyZap(config.sessionKey, config.myzapApiToken);
  if (!myzapDisponivel) {
    return {
      status: 'error',
      message: 'MyZap indisponivel. Verifique se a sessao esta ativa antes de iniciar a fila.'
    };
  }

  ativo = true;
  ultimoErro = null;

  info('Iniciando watcher da fila MyZap', {
    metadata: { area: 'whatsappQueueWatcher', loopMs: LOOP_INTERVAL_MS }
  });

  timer = setInterval(() => {
    debug('[FilaMyZap] Tick de processamento da fila');
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
    return { status: 'success', message: 'Watcher da fila MyZap ja estava parado.' };
  }

  if (timer) {
    clearInterval(timer);
    timer = null;
  }

  ativo = false;
  processando = false;

  info('Watcher da fila MyZap parado', {
    metadata: { area: 'whatsappQueueWatcher' }
  });

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
  getWhatsappQueueWatcherStatus,
  processarFilaUmaRodada
};
