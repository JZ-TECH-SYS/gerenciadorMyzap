const LOOP_INTERVAL_FALLBACK_MS = 3000;
const LOG_POLL_MS = 4000;
const MAX_LOG_LINES_UI = 200;

let nextRunAt = null;
let pollingHandle = null;
let countdownHandle = null;
let logPollingHandle = null;
let lastLogTimestamp = null;
let logEntries = [];

function formatDateTime(value) {
  if (!value) return '-';
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return String(value);
  return dt.toLocaleString('pt-BR');
}

function showInlineError(message) {
  const alertBox = document.getElementById('queue-error-alert');
  if (!alertBox) return;

  if (!message) {
    alertBox.classList.add('d-none');
    alertBox.textContent = '';
    return;
  }

  alertBox.textContent = String(message);
  alertBox.classList.remove('d-none');
}

function extrairResumoMensagem(jsonStr) {
  try {
    const payload = jsonStr ? JSON.parse(jsonStr) : {};
    const numero = payload?.data?.number || '-';
    const texto = payload?.data?.text || '-';
    return { numero, texto };
  } catch (_e) {
    return { numero: '-', texto: 'JSON invalido' };
  }
}

function renderFilaPendentes(mensagens) {
  const tbody = document.getElementById('queue-pendentes-body');
  const total = document.getElementById('queue-total-pendentes');
  if (!tbody || !total) return;

  total.textContent = String(mensagens.length);

  if (!mensagens.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" class="text-center text-muted-small">Nenhuma mensagem pendente.</td>
      </tr>
    `;
    return;
  }

  const linhas = mensagens.map((m) => {
    const { numero, texto } = extrairResumoMensagem(m?.json);
    return `
      <tr>
        <td>${m?.idfila ?? '-'}</td>
        <td>${numero}</td>
        <td class="queue-message-cell">${texto}</td>
        <td>${m?.status ?? '-'}</td>
        <td>${m?.datahorainclusao ?? '-'}</td>
      </tr>
    `;
  }).join('');

  tbody.innerHTML = linhas;
}

function setButtonsState({ ativo, processando }) {
  const btnStart = document.getElementById('btn-start-queue');
  const btnStop = document.getElementById('btn-stop-queue');

  if (btnStart) {
    btnStart.disabled = Boolean(ativo || processando);
  }

  if (btnStop) {
    btnStop.disabled = !Boolean(ativo || processando);
  }
}

function renderCountdown() {
  const countdown = document.getElementById('queue-next-run-countdown');
  if (!countdown) return;

  if (!nextRunAt) {
    countdown.textContent = '-';
    return;
  }

  const remainingMs = nextRunAt - Date.now();
  if (remainingMs <= 0) {
    countdown.textContent = 'agora';
    return;
  }

  const totalSec = Math.ceil(remainingMs / 1000);
  if (totalSec < 60) {
    countdown.textContent = `${totalSec}s`;
  } else {
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    countdown.textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
}

async function atualizarStatusProcessoFila() {
  const badge = document.getElementById('queue-process-status');
  const lastRun = document.getElementById('queue-last-run');
  const lastBatch = document.getElementById('queue-last-batch');
  if (!badge || !lastRun || !lastBatch) return;

  try {
    const status = await window.api.getQueueWatcherStatus();
    const ativo = !!status?.ativo;
    const processando = !!status?.processando;

    badge.textContent = processando ? 'Processando' : (ativo ? 'Ativo' : 'Parado');
    badge.classList.remove('bg-secondary', 'bg-success', 'bg-warning', 'bg-danger');
    badge.classList.add(processando ? 'bg-warning' : (ativo ? 'bg-success' : 'bg-secondary'));

    lastRun.textContent = formatDateTime(status?.ultimaExecucaoEm);
    lastBatch.textContent = String(status?.ultimoLote ?? 0);

    setButtonsState({ ativo, processando });

    const loopIntervalMs = Number(status?.loopIntervalMs) || LOOP_INTERVAL_FALLBACK_MS;
    const nextRunFromApi = status?.proximaExecucaoEm ? new Date(status.proximaExecucaoEm).getTime() : null;
    if (ativo && nextRunFromApi && Number.isFinite(nextRunFromApi)) {
      nextRunAt = nextRunFromApi;
    } else if (ativo && status?.ultimaExecucaoEm) {
      const lastRunTs = new Date(status.ultimaExecucaoEm).getTime();
      nextRunAt = Number.isFinite(lastRunTs) ? (lastRunTs + loopIntervalMs) : null;
    } else {
      nextRunAt = null;
    }

    showInlineError(status?.ultimoErro || '');
  } catch (e) {
    badge.textContent = 'Erro';
    badge.classList.remove('bg-secondary', 'bg-success', 'bg-warning');
    badge.classList.add('bg-danger');
    setButtonsState({ ativo: false, processando: false });
    nextRunAt = null;
    showInlineError(`Falha ao obter status da fila: ${e?.message || e}`);
  }

  renderCountdown();
}

async function atualizarFilaMyZap() {
  try {
    const pendentes = await window.api.getQueuePendentes();
    renderFilaPendentes(Array.isArray(pendentes) ? pendentes : []);
  } catch (e) {
    renderFilaPendentes([]);
    showInlineError(`Falha ao carregar pendentes: ${e?.message || e}`);
  }
}

async function iniciarFilaMyZap() {
  const btn = document.getElementById('btn-start-queue');
  if (!btn) return;

  btn.disabled = true;
  const txt = btn.textContent;
  btn.textContent = 'Iniciando...';

  try {
    const result = await window.api.startQueueWatcher();
    if (result?.status !== 'success') {
      throw new Error(result?.message || 'Falha ao iniciar a fila');
    }

    showInlineError('');
    await atualizarStatusProcessoFila();
    await atualizarFilaMyZap();
  } catch (e) {
    showInlineError(`Erro ao iniciar processo da fila: ${e?.message || e}`);
  } finally {
    btn.textContent = txt;
    await atualizarStatusProcessoFila();
  }
}

async function pararFilaMyZap() {
  const btn = document.getElementById('btn-stop-queue');
  if (!btn) return;

  btn.disabled = true;
  const txt = btn.textContent;
  btn.textContent = 'Parando...';

  try {
    const result = await window.api.stopQueueWatcher();
    if (result?.status !== 'success') {
      throw new Error(result?.message || 'Falha ao parar a fila');
    }

    showInlineError('');
    await atualizarStatusProcessoFila();
  } catch (e) {
    showInlineError(`Erro ao parar processo da fila: ${e?.message || e}`);
  } finally {
    btn.textContent = txt;
    await atualizarStatusProcessoFila();
  }
}

async function refreshAll() {
  await atualizarStatusProcessoFila();
  await atualizarFilaMyZap();
}

// ── Buscar Agora ─────────────────────────────────────────

async function forcarBuscaAgora() {
  const btn = document.getElementById('btn-force-cycle');
  if (!btn) return;

  btn.disabled = true;
  const txt = btn.textContent;
  btn.textContent = 'Buscando...';

  try {
    const result = await window.api.forceQueueCycle();
    if (result?.status !== 'success') {
      throw new Error(result?.message || 'Falha ao executar busca manual');
    }
    showInlineError('');
    await refreshAll();
    await fetchAndRenderLogs();
  } catch (e) {
    showInlineError(`Erro ao buscar agora: ${e?.message || e}`);
  } finally {
    btn.textContent = txt;
    btn.disabled = false;
  }
}

// ── Log em tempo real ────────────────────────────────────

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatLogTimestamp(isoString) {
  if (!isoString) return '';
  const dt = new Date(isoString);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

function formatMeta(metadata) {
  if (!metadata || typeof metadata !== 'object') return '';
  const entries = Object.entries(metadata).filter(([k]) => k !== 'area');
  if (!entries.length) return '';
  return entries.map(([k, v]) => {
    const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return `${k}: ${val}`;
  }).join(', ');
}

function getActiveLogLevel() {
  const select = document.getElementById('log-level-filter');
  return select ? select.value : 'all';
}

function renderLogEntries() {
  const container = document.getElementById('queue-log-container');
  if (!container) return;

  const filterLevel = getActiveLogLevel();
  const filtered = filterLevel === 'all'
    ? logEntries
    : logEntries.filter((e) => e.level === filterLevel);

  if (!filtered.length) {
    container.innerHTML = '<div class="text-center text-muted-small py-3">Nenhum log ' +
      (filterLevel !== 'all' ? `(${filterLevel}) ` : '') + 'encontrado.</div>';
    return;
  }

  const html = filtered.map((entry) => {
    const ts = formatLogTimestamp(entry.timestamp);
    const level = (entry.level || 'info').toLowerCase();
    const msg = escapeHtml(entry.message || '');
    const meta = formatMeta(entry.metadata);
    return `<div class="log-line">
      <span class="log-ts">${ts}</span>
      <span class="log-level-tag ${level}">${escapeHtml(level)}</span>
      <span class="log-msg">${msg}${meta ? ' <span class="log-meta">| ' + escapeHtml(meta) + '</span>' : ''}</span>
    </div>`;
  }).join('');

  container.innerHTML = html;

  // Auto-scroll para o final
  container.scrollTop = container.scrollHeight;
}

async function fetchAndRenderLogs() {
  try {
    const entries = await window.api.getQueueLogs(MAX_LOG_LINES_UI);
    if (!Array.isArray(entries) || !entries.length) return;

    // Filtrar apenas entradas mais recentes que o ultimo timestamp conhecido
    // ou carregar tudo na primeira vez
    if (lastLogTimestamp) {
      const newEntries = entries.filter((e) => e.timestamp > lastLogTimestamp);
      if (newEntries.length) {
        logEntries = logEntries.concat(newEntries);
        // Manter no maximo MAX_LOG_LINES_UI
        if (logEntries.length > MAX_LOG_LINES_UI) {
          logEntries = logEntries.slice(-MAX_LOG_LINES_UI);
        }
      }
    } else {
      logEntries = entries.slice(-MAX_LOG_LINES_UI);
    }

    if (logEntries.length) {
      lastLogTimestamp = logEntries[logEntries.length - 1].timestamp;
    }

    renderLogEntries();
  } catch (_e) {
    // Silencioso — o proximo poll tenta novamente
  }
}

function clearLogView() {
  logEntries = [];
  lastLogTimestamp = null;
  const container = document.getElementById('queue-log-container');
  if (container) {
    container.innerHTML = '<div class="text-center text-muted-small py-3">Log limpo.</div>';
  }
}

(async () => {
  const btnStart = document.getElementById('btn-start-queue');
  const btnStop = document.getElementById('btn-stop-queue');
  const btnForce = document.getElementById('btn-force-cycle');
  const btnClearLog = document.getElementById('btn-clear-log');
  const logLevelFilter = document.getElementById('log-level-filter');

  if (btnStart) {
    btnStart.addEventListener('click', iniciarFilaMyZap);
  }

  if (btnStop) {
    btnStop.addEventListener('click', pararFilaMyZap);
  }

  if (btnForce) {
    btnForce.addEventListener('click', forcarBuscaAgora);
  }

  if (btnClearLog) {
    btnClearLog.addEventListener('click', clearLogView);
  }

  if (logLevelFilter) {
    logLevelFilter.addEventListener('change', renderLogEntries);
  }

  await refreshAll();
  await fetchAndRenderLogs();

  pollingHandle = setInterval(refreshAll, 3000);
  countdownHandle = setInterval(renderCountdown, 1000);
  logPollingHandle = setInterval(fetchAndRenderLogs, LOG_POLL_MS);

  window.addEventListener('beforeunload', () => {
    if (pollingHandle) clearInterval(pollingHandle);
    if (countdownHandle) clearInterval(countdownHandle);
    if (logPollingHandle) clearInterval(logPollingHandle);
  });
})();
