const LOOP_INTERVAL_FALLBACK_MS = 30000;

let nextRunAt = null;
let pollingHandle = null;
let countdownHandle = null;

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
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  countdown.textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
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

(async () => {
  const btnStart = document.getElementById('btn-start-queue');
  const btnStop = document.getElementById('btn-stop-queue');

  if (btnStart) {
    btnStart.addEventListener('click', iniciarFilaMyZap);
  }

  if (btnStop) {
    btnStop.addEventListener('click', pararFilaMyZap);
  }

  await refreshAll();

  pollingHandle = setInterval(refreshAll, 3000);
  countdownHandle = setInterval(renderCountdown, 1000);

  window.addEventListener('beforeunload', () => {
    if (pollingHandle) clearInterval(pollingHandle);
    if (countdownHandle) clearInterval(countdownHandle);
  });
})();
