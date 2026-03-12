const Store = require('electron-store');
const verifyRealStatus = require('../myzap/api/verifyRealStatus');
const { info, warn, error } = require('../myzap/myzapLogger');
const {
  isCapabilityEnabled,
  getCapabilityEntry,
  getBackendApiConfig
} = require('../myzap/capabilities');

const store = new Store();
const LOOP_INTERVAL_MS = 10000;

let ativo = false;
let timer = null;
let ultimoErro = null;
let ultimaExecucaoEm = null;
let ultimoStatus = 'desconhecido';
let trayCallback = null;

function setTrayCallback(fn) {
  trayCallback = typeof fn === 'function' ? fn : null;
}

function getMyzapConnectionStatus() {
  return ultimoStatus;
}

function isMyzapWatcherAtivo() {
  return ativo;
}

function normalizeBaseUrl(url) {
  if (!url || typeof url !== 'string') return '';
  return url.endsWith('/') ? url : `${url}/`;
}

function isPassiveStatusSupported() {
  return isCapabilityEnabled('supportsPassiveStatus', store);
}

function formatDateTimeForApi(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function isMyZapConnected(realStatusPayload) {
  return String(realStatusPayload?.realStatus || '').toUpperCase() === 'CONNECTED';
}

function getActiveConfig() {
  const {
    backendApiUrl,
    backendApiToken
  } = getBackendApiConfig(store);
  const sessionKey = String(store.get('myzap_sessionKey') || '').trim();
  const sessionName = String(store.get('myzap_sessionName') || sessionKey).trim();
  const idempresa = String(store.get('idempresa') || '').trim();

  return {
    backendApiUrl: normalizeBaseUrl(backendApiUrl),
    backendApiToken,
    sessionKey,
    sessionName,
    idempresa
  };
}

async function enviarStatusMyZap() {
  const {
    backendApiUrl,
    backendApiToken,
    sessionKey,
    sessionName,
    idempresa
  } = getActiveConfig();

  ultimaExecucaoEm = new Date().toISOString();

  if (!isPassiveStatusSupported()) {
    info('[StatusMyZap] Atualizacao passiva ignorada por capability desabilitada', {
      metadata: {
        area: 'myzapStatusWatcher',
        capability: getCapabilityEntry('supportsPassiveStatus', store)
      }
    });
    return false;
  }

  if (!backendApiUrl || !backendApiToken || !sessionKey || !sessionName) {
    info('[StatusMyZap] Config incompleta, pulando envio de status', {
      metadata: { area: 'myzapStatusWatcher', backendApiUrl: !!backendApiUrl, backendApiToken: !!backendApiToken, sessionKey: !!sessionKey, sessionName: !!sessionName }
    });
    return false;
  }

  info('[StatusMyZap] Consultando status real do MyZap (verifyRealStatus)', {
    metadata: { area: 'myzapStatusWatcher', sessionKey }
  });

  const realStatusPayload = await verifyRealStatus();
  const status = isMyZapConnected(realStatusPayload) ? 'ativo' : 'inativo';

  if (status !== ultimoStatus) {
    ultimoStatus = status;
    trayCallback?.();
  }

  info('[StatusMyZap] Status resolvido', {
    metadata: { area: 'myzapStatusWatcher', status, realStatus: realStatusPayload?.realStatus }
  });

  const body = {
    sessionKey,
    sessionName,
    status_myzap: status,
    data_ult_verificacao: formatDateTimeForApi()
  };

  if (idempresa) {
    body.idempresa = idempresa;
  }

  info('[StatusMyZap] Enviando PUT para API', {
    metadata: { area: 'myzapStatusWatcher', url: `${backendApiUrl}parametrizacao-myzap/status`, body }
  });

  const res = await fetch(`${backendApiUrl}parametrizacao-myzap/status`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${backendApiToken}`
    },
    body: JSON.stringify(body)
  });

  const data = await res.json().catch(() => ({}));

  info('[StatusMyZap] Resposta da API', {
    metadata: { area: 'myzapStatusWatcher', httpStatus: res.status, responseBody: data }
  });

  if (!res.ok || data?.error) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }

  info('[StatusMyZap] Status atualizado na API com sucesso', {
    metadata: { area: 'myzapStatusWatcher', httpStatus: res.status, statusEnviado: status }
  });

  return true;
}

async function processarUmaRodada() {
  if (!isPassiveStatusSupported()) {
    if (ativo) {
      info('[StatusMyZap] Watcher passivo interrompido porque a capability foi desabilitada', {
        metadata: { area: 'myzapStatusWatcher' }
      });
      stopMyzapStatusWatcher();
    }
    return;
  }

  info('[StatusMyZap] Iniciando ciclo de atualizacao de status', {
    metadata: { area: 'myzapStatusWatcher' }
  });

  try {
    await enviarStatusMyZap();
    ultimoErro = null;
  } catch (err) {
    ultimoErro = err?.message || String(err);
    warn('[StatusMyZap] Falha ao atualizar status passivo do MyZap no backend da empresa', {
      metadata: { area: 'myzapStatusWatcher', error: err?.message || String(err) }
    });
  }
}

async function startMyzapStatusWatcher() {
  if (ativo) {
    return { status: 'success', message: 'Watcher de status passivo do MyZap ja esta em execucao.' };
  }

  if (!isPassiveStatusSupported()) {
    info('[StatusMyZap] Watcher passivo ignorado por capability desabilitada', {
      metadata: {
        area: 'myzapStatusWatcher',
        capability: getCapabilityEntry('supportsPassiveStatus', store)
      }
    });
    return {
      status: 'skipped',
      message: 'Watcher de status passivo ignorado: recurso nao suportado ou desabilitado.'
    };
  }

  ativo = true;
  ultimoErro = null;

  info('Iniciando watcher passivo de status do MyZap', {
    metadata: { area: 'myzapStatusWatcher', loopMs: LOOP_INTERVAL_MS }
  });

  timer = setInterval(() => {
    processarUmaRodada().catch((err) => {
      error('Erro inesperado no loop do watcher de status passivo do MyZap', {
        metadata: { area: 'myzapStatusWatcher', error: err }
      });
    });
  }, LOOP_INTERVAL_MS);

  await processarUmaRodada();
  return { status: 'success', message: 'Watcher de status passivo do MyZap iniciado com sucesso.' };
}

function resetUltimoStatus() {
  if (ultimoStatus !== 'desconhecido') {
    ultimoStatus = 'desconhecido';
    trayCallback?.();
  }
}

function stopMyzapStatusWatcher() {
  if (!ativo && !timer) {
    return { status: 'success', message: 'Watcher de status passivo do MyZap ja estava parado.' };
  }

  if (timer) {
    clearInterval(timer);
    timer = null;
  }

  ativo = false;
  resetUltimoStatus();

  info('Watcher passivo de status do MyZap parado', {
    metadata: { area: 'myzapStatusWatcher' }
  });

  return { status: 'success', message: 'Watcher de status passivo do MyZap parado com sucesso.' };
}

function getMyzapStatusWatcherInfo() {
  return {
    ativo,
    capabilityEnabled: isPassiveStatusSupported(),
    ultimoErro,
    ultimaExecucaoEm,
    loopIntervalMs: LOOP_INTERVAL_MS
  };
}

module.exports = {
  startMyzapStatusWatcher,
  stopMyzapStatusWatcher,
  getMyzapStatusWatcherInfo,
  getMyzapConnectionStatus,
  isMyzapWatcherAtivo,
  setTrayCallback,
  enviarStatusMyZap
};
