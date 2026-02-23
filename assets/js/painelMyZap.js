function setButtonsState({ canStart, canDelete }) {
  const btnStart = document.getElementById('btn-start-session');
  const btnDelete = document.getElementById('btn-delete-session');

  if (btnStart) btnStart.disabled = !canStart;
  if (btnDelete) btnDelete.disabled = !canDelete;
}

function setIaConfigVisibility(isVisible) {
  const box = document.getElementById('ia-config-box');
  if (!box) return;
  box.classList.toggle('d-none', !isVisible);
}

const CONFIG_SYNC_INTERVAL_MS = 30 * 1000;
const QUEUE_POLL_INTERVAL_MS = 30 * 1000;
const STATUS_WATCH_INTERVAL_MS = 10 * 1000;
const PROGRESS_POLL_INTERVAL_MS = 1000;
const STALE_PROGRESS_HIDE_MS = 15 * 60 * 1000;

let myzapProgressPollTimer = null;
let qrPollingTimer = null;
let qrPollingAttempts = 0;
const QR_POLL_INTERVAL_MS = 3000;
const QR_POLL_MAX_ATTEMPTS = 40; // ~120s total

function clampPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function getProgressPercentByPhase(phase) {
  const map = {
    start: 5,
    prepare: 10,
    remote_validate: 15,
    check_install: 25,
    install_local: 35,
    update_existing_install: 55,
    precheck: 10,
    reinstall_cleanup: 20,
    clone_repo: 35,
    install_dependencies: 55,
    sync_configs: 75,
    restart_service: 78,
    start_service: 88,
    check_runtime: 86,
    git_pull: 90,
    run_start: 93,
    wait_port: 96,
    ready: 98,
    start_confirmed: 95,
    sync_ia: 97,
    already_running: 95,
    done: 100,
    error: 100,
    mode_web: 100
  };

  return map[String(phase || '').trim().toLowerCase()] ?? 0;
}

function getProgressPhaseLabel(phase) {
  const normalized = String(phase || '').trim().toLowerCase();
  if (!normalized) return 'aguardando';

  const labels = {
    start: 'inicio',
    prepare: 'preparacao',
    remote_validate: 'validacao remota',
    check_install: 'verificacao local',
    install_local: 'instalacao local',
    update_existing_install: 'atualizacao local',
    precheck: 'pre-requisitos',
    reinstall_cleanup: 'limpeza',
    clone_repo: 'clone git',
    install_dependencies: 'dependencias',
    sync_configs: 'sync configs',
    restart_service: 'reinicio',
    start_service: 'inicializacao',
    check_runtime: 'runtime',
    git_pull: 'git pull',
    run_start: 'start',
    wait_port: 'porta local',
    ready: 'servico pronto',
    start_confirmed: 'confirmacao',
    sync_ia: 'sync ia',
    already_running: 'ja em execucao',
    done: 'concluido',
    error: 'erro',
    mode_web: 'modo online'
  };

  return labels[normalized] || normalized.replace(/_/g, ' ');
}

function shouldHideProgress(progress) {
  if (!progress || typeof progress !== 'object') return true;
  if (!progress.active && String(progress.phase || '').toLowerCase() === 'mode_web') {
    return true;
  }
  // Esconder quando ja concluido com sucesso e processo nao esta mais ativo
  if (!progress.active && String(progress.state || '').toLowerCase() === 'success') {
    return true;
  }
  if (!progress.active) {
    const updatedAt = Number(progress.updated_at || 0);
    if (updatedAt > 0 && (Date.now() - updatedAt) > STALE_PROGRESS_HIDE_MS) {
      return true;
    }
  }
  return false;
}

function resolveProgressPercent(progress = {}) {
  const fromMetadata = progress?.metadata?.percent;
  if (fromMetadata !== undefined && fromMetadata !== null && fromMetadata !== '') {
    return clampPercent(fromMetadata);
  }
  return clampPercent(getProgressPercentByPhase(progress?.phase));
}

function applyProgressStateClasses(box, bar, state, isActive) {
  box.classList.remove('alert-info', 'alert-success', 'alert-danger', 'alert-secondary');
  bar.classList.remove('bg-info', 'bg-success', 'bg-danger');

  if (state === 'success') {
    box.classList.add('alert-success');
    bar.classList.add('bg-success');
    bar.classList.remove('progress-bar-animated');
    return;
  }

  if (state === 'error') {
    box.classList.add('alert-danger');
    bar.classList.add('bg-danger');
    bar.classList.remove('progress-bar-animated');
    return;
  }

  box.classList.add('alert-info');
  bar.classList.add('bg-info');
  if (isActive) {
    bar.classList.add('progress-bar-animated');
  } else {
    bar.classList.remove('progress-bar-animated');
  }
}

function renderMyZapProgress(progress) {
  const box = document.getElementById('myzap-progress-box');
  const title = document.getElementById('myzap-progress-title');
  const phase = document.getElementById('myzap-progress-phase');
  const message = document.getElementById('myzap-progress-message');
  const bar = document.getElementById('myzap-progress-bar');
  const updated = document.getElementById('myzap-progress-updated');
  const statusApi = document.getElementById('status-api');

  if (!box || !title || !phase || !message || !bar || !updated) return;

  if (shouldHideProgress(progress)) {
    box.classList.add('d-none');
    return;
  }

  const state = String(progress?.state || (progress?.active ? 'running' : '') || 'running').toLowerCase();
  const phaseLabel = getProgressPhaseLabel(progress?.phase);
  const percent = (state === 'success')
    ? 100
    : resolveProgressPercent(progress);
  const isActive = Boolean(progress?.active);

  box.classList.remove('d-none');
  title.textContent = isActive ? 'Processo local do MyZap em andamento' : 'Ultimo processo local do MyZap';
  phase.textContent = phaseLabel;
  message.textContent = String(progress?.message || 'Aguardando execucao...');
  bar.style.width = `${percent}%`;
  bar.textContent = `${percent}%`;
  bar.setAttribute('aria-valuenow', String(percent));
  updated.textContent = `Ultima atualizacao: ${formatDateTimeBR(progress?.updated_at)}`;

  applyProgressStateClasses(box, bar, state, isActive);

  if (statusApi && isActive) {
    statusApi.textContent = `Processando: ${progress?.message || 'instalando MyZap local...'}`;
    statusApi.className = 'badge bg-warning text-dark status-badge';
  }
}

async function refreshMyZapProgress() {
  try {
    const progress = await window.api.getStore('myzap_progress');
    const modoIntegracao = (await window.api.getStore('myzap_modoIntegracao')) ?? 'local';
    const remoteConfigOk = Boolean(await window.api.getStore('myzap_remoteConfigOk'));
    const modoLocalAtivo = remoteConfigOk && isModoLocal(modoIntegracao);

    if (!modoLocalAtivo && !progress?.active) {
      renderMyZapProgress(null);
      return;
    }

    renderMyZapProgress(progress);
  } catch (err) {
    console.warn('Falha ao carregar progresso MyZap:', err?.message || err);
  }
}

function startMyZapProgressPolling() {
  if (myzapProgressPollTimer) return;
  refreshMyZapProgress();
  myzapProgressPollTimer = setInterval(() => {
    refreshMyZapProgress();
  }, PROGRESS_POLL_INTERVAL_MS);
}

function normalizeModoIntegracao(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'local';

  if (raw.includes('fila') || raw.includes('local')) return 'local';
  if (raw.includes('web') || raw.includes('online') || raw.includes('cloud') || raw.includes('nuvem')) return 'web';
  return raw;
}

function isModoLocal(value) {
  return normalizeModoIntegracao(value) === 'local';
}

function formatDateTimeBR(value) {
  const ts = Number(value || 0);
  if (!ts) return 'ainda nao sincronizado';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return 'ainda nao sincronizado';
  return d.toLocaleString('pt-BR');
}

function renderRuntimeInfo({ modoIntegracao, lastSyncAt, remoteConfigOk = true }) {
  const box = document.getElementById('myzap-runtime-info');
  if (!box) return;

  const modo = normalizeModoIntegracao(modoIntegracao);
  const modoLabel = modo === 'local' ? 'local/fila' : 'web/online';

  box.innerHTML = `
    <div><strong>Modo atual:</strong> ${modoLabel}</div>
    <div><strong>Configuracao remota validada:</strong> ${remoteConfigOk ? 'sim' : 'nao'}</div>
    <div><strong>Sincronizacao API -> gerenciador:</strong> a cada ${CONFIG_SYNC_INTERVAL_MS / 1000}s</div>
    <div><strong>Troca de modo no ClickExpress:</strong> aplicada automaticamente em ate ${CONFIG_SYNC_INTERVAL_MS / 1000}s</div>
    <div><strong>Tentativa de iniciar fila local:</strong> a cada ${QUEUE_POLL_INTERVAL_MS / 1000}s (somente modo local)</div>
    <div><strong>Atualizacao de status passivo:</strong> a cada ${STATUS_WATCH_INTERVAL_MS / 1000}s (somente modo local)</div>
    <div><strong>Atualizacao de codigo do MyZap (git pull):</strong> ao iniciar o MyZap local</div>
    <div><strong>Ultima sincronizacao remota:</strong> ${formatDateTimeBR(lastSyncAt)}</div>
  `;
}

function applyModoInfoBanner(modoIntegracao) {
  const box = document.getElementById('myzap-modo-info');
  if (!box) return;
  const modo = normalizeModoIntegracao(modoIntegracao);

  if (modo === 'local') {
    box.classList.remove('alert-warning');
    box.classList.add('alert-info');
    box.textContent = `Modo local/fila ativo. O gerenciador instala/sincroniza/inicia o MyZap automaticamente e revalida config a cada ${CONFIG_SYNC_INTERVAL_MS / 1000}s.`;
    return;
  }

  box.classList.remove('alert-info');
  box.classList.add('alert-warning');
  box.textContent = `Modo web/online ativo. O MyZap local esta desativado neste computador. Atualize no ClickExpress para modo local/fila se quiser usar WhatsApp local. A sincronizacao aplica em ate ${CONFIG_SYNC_INTERVAL_MS / 1000}s.`;
}

function setOnlineOnlyView(enabled, customMessage = '') {
  const onlineBox = document.getElementById('myzap-online-only');
  const localContent = document.getElementById('myzap-local-content');
  const myzapTabBtn = document.getElementById('myzap-tab');
  const myzapPane = document.getElementById('myzap');
  const statusTabBtn = document.getElementById('status-tab');
  const statusTabItem = statusTabBtn?.closest('li');
  const statusPane = document.getElementById('status');
  const runtimeInfo = document.getElementById('myzap-runtime-info');

  if (!onlineBox || !localContent) return;

  if (enabled) {
    onlineBox.classList.remove('d-none');
    localContent.classList.add('d-none');
    if (statusTabItem) statusTabItem.classList.add('d-none');
    if (statusPane) {
      statusPane.classList.add('d-none');
      statusPane.classList.remove('show', 'active');
    }
    if (myzapTabBtn) myzapTabBtn.classList.add('active');
    if (myzapPane) myzapPane.classList.add('show', 'active');
    if (statusTabBtn) statusTabBtn.classList.remove('active');
    if (runtimeInfo) runtimeInfo.classList.add('d-none');
    onlineBox.textContent = customMessage || `Modo web/online ativo. As mensagens do WhatsApp estao sendo enviadas de forma online (nao local). Para usar WhatsApp local, altere o modo para local/fila no ClickExpress. Aplicacao automatica em ate ${CONFIG_SYNC_INTERVAL_MS / 1000}s.`;
    return;
  }

  onlineBox.classList.add('d-none');
  localContent.classList.remove('d-none');
  if (statusTabItem) statusTabItem.classList.remove('d-none');
  if (statusPane) statusPane.classList.remove('d-none');
  if (runtimeInfo) runtimeInfo.classList.remove('d-none');
}

async function isModoLocalAtivo() {
  const modo = (await window.api.getStore('myzap_modoIntegracao')) ?? 'local';
  const remoteOk = Boolean(await window.api.getStore('myzap_remoteConfigOk'));
  return remoteOk && isModoLocal(modo);
}

let configAutoRefreshTimer = null;

async function refreshConfigFromApiAndRender() {
  const autoConfig = await window.api.prepareMyZapAutoConfig(true);
  if (autoConfig?.status === 'error') {
    setOnlineOnlyView(true, `Nao foi possivel consultar a rota de configuracao do MyZap agora: ${autoConfig?.message || 'erro desconhecido'}. Verifique API/Token/Empresa e tente novamente.`);
    await refreshMyZapProgress();
    return;
  }

  const myzap_modoIntegracao = (await window.api.getStore('myzap_modoIntegracao')) ?? 'local';
  const myzap_lastRemoteConfigSyncAt = (await window.api.getStore('myzap_lastRemoteConfigSyncAt')) ?? 0;
  const myzap_remoteConfigOk = Boolean(await window.api.getStore('myzap_remoteConfigOk'));
  const modoLocal = isModoLocal(myzap_modoIntegracao);

  applyModoInfoBanner(myzap_modoIntegracao);
  renderRuntimeInfo({
    modoIntegracao: myzap_modoIntegracao,
    lastSyncAt: myzap_lastRemoteConfigSyncAt,
    remoteConfigOk: myzap_remoteConfigOk
  });
  if (!myzap_remoteConfigOk) {
    setOnlineOnlyView(true, `Nao foi possivel validar a configuracao do MyZap na API neste momento. O painel local foi bloqueado para evitar decisao por cache. Verifique API/Token/Empresa e tente novamente.`);
  } else {
    setOnlineOnlyView(!modoLocal);
  }

  const statusApi = document.getElementById('status-api');
  const statusInstallation = document.getElementById('status-installation');
  const statusConfig = document.getElementById('status-config');
  const btnStart = document.getElementById('btn-start');

  if (!myzap_remoteConfigOk || !modoLocal) {
    if (statusApi) {
      statusApi.textContent = !myzap_remoteConfigOk
        ? 'Nao foi possivel validar modo na API. Start local bloqueado.'
        : `Modo web/online: start local desativado. Troque para local/fila no ClickExpress (sync em ate ${CONFIG_SYNC_INTERVAL_MS / 1000}s).`;
      statusApi.className = 'badge bg-info text-dark status-badge';
    }
    if (statusInstallation) {
      statusInstallation.textContent = !myzap_remoteConfigOk
        ? 'Modo nao validado na API'
        : 'Nao aplicavel no modo web/online';
      statusInstallation.className = 'badge bg-info text-dark status-badge';
    }
    if (statusConfig) {
      statusConfig.textContent = 'Automatico via API';
      statusConfig.className = 'badge bg-info text-dark status-badge';
    }
    if (btnStart) btnStart.disabled = true;
    setButtonsState({ canStart: false, canDelete: false });
    setIaConfigVisibility(false);
  }

  await refreshMyZapProgress();
}

function startConfigAutoRefresh() {
  if (configAutoRefreshTimer) return;
  configAutoRefreshTimer = setInterval(() => {
    refreshConfigFromApiAndRender().catch((err) => {
      console.warn('Falha no refresh automatico de config MyZap:', err?.message || err);
    });
  }, CONFIG_SYNC_INTERVAL_MS);
}


(async () => {
  try {
    // Se usuario removeu tudo anteriormente, manter estado entre reaberturas do app
    const userRemoved = await window.api.getStore('myzap_userRemovedLocal');
    if (userRemoved === true) {
      setPanelVisible(false);
      setResetFeedback({
        show: true,
        type: 'success',
        icon: '',
        title: 'MyZap foi removido',
        message: 'O MyZap local foi removido. Clique em "Instalar Novamente" para reinstalar com TOKEN gerado automaticamente.',
        details: null,
        showInstallAgain: true
      });
      return;
    }
    await loadConfigs();
    startMyZapProgressPolling();
    startConfigAutoRefresh();
  } catch (e) {
    alert('Erro ao carregar configuracoes: ' + (e?.message || e));
  }
})();


async function loadConfigs() {
  try {
    const autoConfig = await window.api.prepareMyZapAutoConfig(true);
    const remoteConfigOk = autoConfig?.status !== 'error';
    if (autoConfig?.status === 'error') {
      console.warn('Falha na prepara??o autom?tica do MyZap:', autoConfig?.message);
    }
    const configTab = document.getElementById('config-tab');
    const configTabItem = configTab?.closest('li');
    const configPane = document.getElementById('config');
    const installGroup = document.getElementById('install-group');
    if (installGroup) installGroup.classList.add('d-none');
    const myzap_diretorio = (await window.api.getStore('myzap_diretorio')) ?? '';
    const myzap_sessionKey = (await window.api.getStore('myzap_sessionKey')) ?? '';
    const myzap_sessionName = (await window.api.getStore('myzap_sessionName')) ?? myzap_sessionKey;
    const myzap_apiToken = (await window.api.getStore('myzap_apiToken')) ?? '';
    const myzap_envContent = (await window.api.getStore('myzap_envContent')) ?? '';
    const myzap_mensagemPadrao = (await window.api.getStore('myzap_mensagemPadrao')) ?? '';
    const myzap_modoIntegracao = (await window.api.getStore('myzap_modoIntegracao')) ?? 'local';
    const myzap_lastRemoteConfigSyncAt = (await window.api.getStore('myzap_lastRemoteConfigSyncAt')) ?? 0;
    const myzap_remoteConfigOk = Boolean(await window.api.getStore('myzap_remoteConfigOk'));
    const clickexpress_apiUrl = (await window.api.getStore('clickexpress_apiUrl')) ?? '';
    const clickexpress_queueToken = (await window.api.getStore('clickexpress_queueToken')) ?? '';
    const modoLocal = isModoLocal(myzap_modoIntegracao);

    applyModoInfoBanner(myzap_modoIntegracao);
    renderRuntimeInfo({
      modoIntegracao: myzap_modoIntegracao,
      lastSyncAt: myzap_lastRemoteConfigSyncAt,
      remoteConfigOk: myzap_remoteConfigOk
    });
    setOnlineOnlyView(
      !remoteConfigOk || !myzap_remoteConfigOk || !modoLocal,
      !remoteConfigOk
        ? `Nao foi possivel consultar a rota de configuracao do MyZap agora: ${autoConfig?.message || 'erro desconhecido'}. Verifique API/Token/Empresa e tente novamente.`
        : (!myzap_remoteConfigOk
          ? 'Nao foi possivel validar a configuracao do MyZap na API neste momento. O painel local foi bloqueado para evitar decisao por cache.'
          : '')
    );

    const statusConfig = document.getElementById('status-config');
    if (!myzap_remoteConfigOk || !modoLocal) {
      statusConfig.textContent = 'Automatico via API';
      statusConfig.classList.remove('bg-secondary', 'bg-danger', 'bg-success');
      statusConfig.classList.add('bg-info', 'text-dark');
    } else if (myzap_diretorio && myzap_sessionKey && myzap_apiToken && myzap_envContent) {
      statusConfig.textContent = 'Tudo em ordem!';
      statusConfig.classList.remove('bg-secondary');
      statusConfig.classList.add('bg-success');
    }
    const statusInstallation = document.getElementById('status-installation');
    const statusApi = document.getElementById('status-api');
    const btnStart = document.getElementById('btn-start');

    if (!myzap_remoteConfigOk || !modoLocal) {
      statusInstallation.textContent = !myzap_remoteConfigOk
        ? 'Modo nao validado na API'
        : 'Nao aplicavel no modo web/online';
      statusInstallation.classList.remove('bg-secondary', 'bg-danger', 'bg-success');
      statusInstallation.classList.add('bg-info', 'text-dark');
      setInstalled(false);

      statusApi.textContent = !myzap_remoteConfigOk
        ? 'Nao foi possivel validar modo na API. Start local bloqueado.'
        : `Modo web/online: start local desativado. Troque para local/fila no ClickExpress (sync em ate ${CONFIG_SYNC_INTERVAL_MS / 1000}s).`;
      statusApi.classList.remove('bg-secondary', 'bg-danger', 'bg-success');
      statusApi.classList.add('bg-info', 'text-dark');
      btnStart.disabled = true;
      setButtonsState({ canStart: false, canDelete: false });
      setIaConfigVisibility(false);
    } else {
      const hasFiles = await window.api.checkDirectoryHasFiles(
        String(myzap_diretorio)
      );
      statusInstallation.textContent = hasFiles.message || 'Erro na configuracao!';
      statusInstallation.classList.remove('bg-secondary');
      statusInstallation.classList.add(hasFiles.status === 'success' ? 'bg-success' : 'bg-danger');
      setInstalled(hasFiles.status === 'success');
      btnStart.disabled = false;

      if (hasFiles.status === 'success') {
        statusApi.innerHTML = `
              <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
              Verificando...
          `;
        const realStatus = await window.api.verifyRealStatus();
        const localApiAcessivel = Boolean(
          realStatus && (
            realStatus.status
            || realStatus.realStatus
            || realStatus.dbStatus
            || realStatus.dbState
          )
        );

        statusApi.classList.remove('bg-secondary', 'bg-info', 'bg-danger', 'bg-success', 'bg-warning', 'text-dark');
        if (localApiAcessivel) {
          statusApi.textContent = 'MyZap local acessivel.';
          statusApi.classList.add('bg-success');
          btnStart.disabled = true;
        } else {
          statusApi.textContent = 'MyZap local parado. Clique em Iniciar MyZap.';
          statusApi.classList.add('bg-warning', 'text-dark');
          btnStart.disabled = false;
        }
      }
    }

    if (myzap_sessionKey) {
      document.getElementById('myzap-sessionkey').value = myzap_sessionKey;
      document.getElementById('myzap-sessionname').value = myzap_sessionName || myzap_sessionKey;
    }
    if (document.getElementById('myzap-sessionkey')) {
      document.getElementById('myzap-sessionkey').placeholder = 'Carregado automaticamente da API';
    }
    if (document.getElementById('myzap-sessionname')) {
      document.getElementById('myzap-sessionname').placeholder = 'Carregado automaticamente da API';
    }
    if (modoLocal && myzap_sessionKey) {
      setInterval(async () => {
        await checkConnection();
      }, STATUS_WATCH_INTERVAL_MS);
    }

    if (document.getElementById('myzap-mensagem-padrao')) document.getElementById('myzap-mensagem-padrao').value = myzap_mensagemPadrao;

    // Carrega segredos do .env para a aba de configurações
    try {
      const envSecrets = await window.api.readEnvSecrets();
      if (document.getElementById('input-env-token')) document.getElementById('input-env-token').value = envSecrets.TOKEN || '';
      if (document.getElementById('input-env-openai')) document.getElementById('input-env-openai').value = envSecrets.OPENAI_API_KEY || '';
      if (document.getElementById('input-env-emailtoken')) document.getElementById('input-env-emailtoken').value = envSecrets.EMAIL_TOKEN || '';
      // Mostrar hint + botão "Salvar e Instalar" se TOKEN vazio
      updateConfigInstallHint(envSecrets.TOKEN || '');
    } catch (envErr) {
      console.warn('Falha ao carregar segredos do .env:', envErr?.message || envErr);
    }

    await refreshMyZapProgress();
  } catch (e) {
    alert('Erro ao carregar configura??es: ' + (e?.message || e));
  }
}

async function checkRealConnection() {
  console.log('[MyZap UI] checkRealConnection: iniciando verificacao de status real');
  const qrBox = document.getElementById('qrcode-box');
  const statusIndicator = document.querySelector('.status-indicator');

  qrBox.innerHTML = `<span class="text-muted-small">Verificando status real...</span>`;

  try {
    const response = await window.api.verifyRealStatus();

    if (!response.dbStatus && !response.status) {
      throw new Error('Resposta invalida da API');
    }

    const {
      realStatus,
      dbStatus,
      dbState,
      status,
      message
    } = response;

    if (status == 'NOT FOUND') {
      statusIndicator.className = 'status-indicator waiting';
      statusIndicator.textContent = 'Sessao nao iniciada!';

      qrBox.innerHTML = `
        <span class="text-muted-small">
          Nenhuma instancia de sessao foi criada!
        </span>
      `;

      setButtonsState({ canStart: true, canDelete: false });
      setIaConfigVisibility(false);
      return { isConnected: false, isQrWaiting: false, response };
    }

    const isConnected = realStatus === 'CONNECTED';
    const isQrWaiting = dbState === 'QRCODE' || dbStatus === 'qrCode';

    if (isConnected) {
      statusIndicator.className = 'status-indicator connected';
      statusIndicator.textContent = 'Conectado';

      qrBox.innerHTML = `
        <span class="text-muted-small">
          WhatsApp conectado com sucesso
        </span>
      `;

      setButtonsState({ canStart: false, canDelete: true });
      setIaConfigVisibility(true);
      return { isConnected: true, isQrWaiting: false, response };
    }

    if (isQrWaiting) {
      statusIndicator.className = 'status-indicator waiting';
      statusIndicator.textContent = 'â³ Aguardando leitura do QR Code';

      setButtonsState({ canStart: false, canDelete: true });
      setIaConfigVisibility(false);
      return { isConnected: false, isQrWaiting: true, response };
    }

    statusIndicator.className = 'status-indicator disconnected';
    statusIndicator.textContent = 'âŒ Desconectado';

    qrBox.innerHTML = `
      <span class="text-muted-small">
        ${message || 'QR Code nao disponivel'}
      </span>
    `;

    setButtonsState({ canStart: true, canDelete: false });
    setIaConfigVisibility(false);
    return { isConnected: false, isQrWaiting: false, response };

  } catch (err) {
    console.error('Erro ao verificar status real:', err);

    statusIndicator.className = 'status-indicator disconnected';
    statusIndicator.textContent = 'âš  Erro de conexÃ£o';

    qrBox.innerHTML = `
      <span class="text-danger text-small">
        Erro ao verificar status do MyZap
      </span>
    `;

    setButtonsState({ canStart: false, canDelete: false });
    setIaConfigVisibility(false);
    return { isConnected: false, isQrWaiting: false, response: null };
  }
}

async function checkConnection() {
  console.log('[MyZap UI] checkConnection: verificando modo e status');
  const qrBox = document.getElementById('qrcode-box');
  const statusIndicator = document.querySelector('.status-indicator');

  if (!(await isModoLocalAtivo())) {
    statusIndicator.className = 'status-indicator waiting';
    statusIndicator.textContent = 'Modo local inativo ou nao validado';
    qrBox.innerHTML = `<span class="text-muted-small">QR Code local indisponivel. Verifique o modo no ClickExpress e a validacao da rota de configuracao.</span>`;
    setButtonsState({ canStart: false, canDelete: false });
    setIaConfigVisibility(false);
    return;
  }

  // loading simples (opcional)
  qrBox.innerHTML = `<span class="text-muted-small">Verificando status...</span>`;

  try {
    const realCheck = await checkRealConnection();

    if (!realCheck || realCheck.isConnected) {
      return;
    }

    if (!realCheck.isQrWaiting) {
      return;
    }

    const response = await window.api.getConnectionStatus();

    if (!response || response.result !== 200) {
      throw new Error('Resposta invalida da API');
    }

    const { status, state, qrCode } = response;

    if ((state === 'QRCODE' || status === 'qrCode') && qrCode) {
      statusIndicator.className = 'status-indicator waiting';
      statusIndicator.textContent = 'â³ Aguardando leitura do QR Code';

      qrBox.innerHTML = `
        <img 
          src="${qrCode}" 
          alt="QR Code WhatsApp"
        />
        <div class="qrcode-hint">
          Escaneie o QR Code com o WhatsApp
        </div>
      `;
    }

  } catch (err) {
    console.error('Erro ao verificar conexao:', err);

    statusIndicator.className = 'status-indicator disconnected';
    statusIndicator.textContent = 'âš  Erro de conexÃ£o';

    qrBox.innerHTML = `
      <span class="text-danger text-small">
        Erro ao verificar status do MyZap
      </span>
    `;
  }
}

function stopQrPolling() {
  if (qrPollingTimer) {
    clearInterval(qrPollingTimer);
    qrPollingTimer = null;
  }
  qrPollingAttempts = 0;
}

async function tickQrPolling() {
  console.log('[MyZap UI] tickQrPolling: tentativa', qrPollingAttempts + 1, '/ ' + QR_POLL_MAX_ATTEMPTS);
  const qrBox = document.getElementById('qrcode-box');
  const statusIndicator = document.querySelector('.status-indicator');
  if (!qrBox || !statusIndicator) { stopQrPolling(); return; }

  try {
    // Se ja conectou, parar tudo
    const snap = await window.api.verifyRealStatus();
    console.log('[MyZap UI] verifyRealStatus snap:', JSON.stringify(snap));
    if (snap?.realStatus === 'CONNECTED') {
      stopQrPolling();
      statusIndicator.className = 'status-indicator connected';
      statusIndicator.textContent = '\u2705 Conectado';
      qrBox.innerHTML = '<span class="text-muted-small">WhatsApp conectado com sucesso</span>';
      setButtonsState({ canStart: false, canDelete: true });
      setIaConfigVisibility(true);
      return;
    }

    // Se QR ja esta exibido, apenas aguardar o scan (continua polling para detectar conexao)
    if (qrBox.querySelector('img')) return;

    // Buscar QR code diretamente — sem depender do estado QRCODE no verifyRealStatus
    const connStatus = await window.api.getConnectionStatus();
    console.log('[MyZap UI] getConnectionStatus resposta:', JSON.stringify(connStatus));
    if (!connStatus || Array.isArray(connStatus)) return;

    const qrCode = connStatus.qrCode || connStatus.qr_code || connStatus.base64Qrimg || '';
    if (qrCode) {
      statusIndicator.className = 'status-indicator waiting';
      statusIndicator.textContent = '\u23F3 Aguardando leitura do QR Code';
      qrBox.innerHTML = `
        <img src="${qrCode}" alt="QR Code WhatsApp"/>
        <div class="qrcode-hint">Escaneie o QR Code com o WhatsApp</div>
      `;
      setButtonsState({ canStart: false, canDelete: true });
    }
  } catch (err) {
    // silencioso — nao interromper o polling por erros transientes
  }
}

function startQrPolling() {
  stopQrPolling();
  // Primeira tentativa apos 2s (MyZap precisa de tempo para gerar o QR)
  setTimeout(tickQrPolling, 2000);
  qrPollingTimer = setInterval(async () => {
    qrPollingAttempts++;
    if (qrPollingAttempts > QR_POLL_MAX_ATTEMPTS) {
      stopQrPolling();
      const qrBox = document.getElementById('qrcode-box');
      if (qrBox && !qrBox.querySelector('img')) {
        qrBox.innerHTML = '<span class="text-muted-small">Timeout aguardando QR Code. Clique em Iniciar instancia para tentar novamente.</span>';
      }
      return;
    }
    await tickQrPolling();
  }, QR_POLL_INTERVAL_MS);
}

async function iniciarSessao() {
  console.log('[MyZap UI] iniciarSessao: botao clicado');
  if (!(await isModoLocalAtivo())) {
    alert(`Modo local inativo ou nao validado pela API. Verifique o modo no ClickExpress e aguarde ate ${CONFIG_SYNC_INTERVAL_MS / 1000}s para sincronizacao.`);
    return;
  }

  const qrBox = document.getElementById('qrcode-box');
  const statusIndicator = document.querySelector('.status-indicator');

  try {
    const realCheck = await checkRealConnection();
    if (realCheck?.isConnected || realCheck?.isQrWaiting) {
      statusIndicator.className = 'status-indicator waiting';
      statusIndicator.textContent = 'âš  SessÃ£o jÃ¡ existe';

      setButtonsState({ canStart: false, canDelete: true });
      return;
    }

    statusIndicator.className = 'status-indicator waiting';
    statusIndicator.textContent = 'Iniciando sessao...';

    qrBox.innerHTML = `
      <span class="text-muted-small">
        Criando sessao no MyZap, aguarde...
      </span>
    `;

    const response = await window.api.startSession();
    console.log('[MyZap UI] startSession resposta:', JSON.stringify(response));

    if (!response || response.result !== 'success') {
      throw new Error('Sem resposta do MyZap. Verifique se o servico esta rodando (porta 5555).');
    }

    // 3ï¸âƒ£ Atualiza UI
    statusIndicator.textContent = 'â³ SessÃ£o iniciada, aguardando QR Code';

    setButtonsState({ canStart: false, canDelete: true });

    // opcional: forÃ§ar refresh do status
    setTimeout(checkConnection, 5000);

  } catch (err) {
    console.error('Erro ao iniciar sessao:', err);

    statusIndicator.className = 'status-indicator disconnected';
    statusIndicator.textContent = 'âŒ Erro ao iniciar sessÃ£o';

    qrBox.innerHTML = `
      <span class="text-danger text-small">
        Nao foi possivel iniciar a sessao
      </span>
    `;
  }
}


async function deletarSessao() {
  console.log('[MyZap UI] deletarSessao: botao clicado');
  stopQrPolling(); // Cancelar polling de QR em andamento
  if (!(await isModoLocalAtivo())) {
    alert(`Modo local inativo ou nao validado pela API. Verifique o modo no ClickExpress e aguarde ate ${CONFIG_SYNC_INTERVAL_MS / 1000}s para sincronizacao.`);
    return;
  }

  const qrBox = document.getElementById('qrcode-box');
  const statusIndicator = document.querySelector('.status-indicator');

  try {
    // 1ï¸âƒ£ Verifica se existe sessÃ£o
    const realCheck = await checkRealConnection();

    if (!realCheck || (!realCheck.isConnected && !realCheck.isQrWaiting)) {
      statusIndicator.className = 'status-indicator disconnected';
      statusIndicator.textContent = 'Nenhuma sessao ativa';

      setButtonsState({ canStart: true, canDelete: false });
      return;
    }

    // 2ï¸âƒ£ Feedback visual
    statusIndicator.className = 'status-indicator waiting';
    statusIndicator.textContent = 'Encerrando sessao...';

    qrBox.innerHTML = `
      <span class="text-muted-small">
        Encerrando sessao do WhatsApp...
      </span>
    `;

    // 3ï¸âƒ£ Chamada de delete
    const response = await window.api.deleteSession();

    if (!response || response.status !== 'SUCCESS') {
      throw new Error('Falha ao deletar sessao');
    }

    // 4ï¸âƒ£ UI final
    statusIndicator.className = 'status-indicator disconnected';
    statusIndicator.textContent = 'âŒ SessÃ£o encerrada';

    qrBox.innerHTML = `
      <span class="text-muted-small">
        Sessao removida com sucesso
      </span>
    `;

    setButtonsState({ canStart: true, canDelete: false });

  } catch (err) {
    console.error('Erro ao deletar sessao:', err);

    statusIndicator.className = 'status-indicator disconnected';
    statusIndicator.textContent = 'âš  Erro ao deletar sessÃ£o';

    qrBox.innerHTML = `
      <span class="text-danger text-small">
        Nao foi possivel encerrar a sessao
      </span>
    `;
  }
}

async function salvarMensagemPadrao() {
  if (!(await isModoLocalAtivo())) {
    alert(`Modo local inativo ou nao validado pela API. Para aplicar no local, verifique o modo no ClickExpress e aguarde ate ${CONFIG_SYNC_INTERVAL_MS / 1000}s.`);
    return;
  }

  const textarea = document.getElementById('myzap-mensagem-padrao');
  const btnSave = document.getElementById('btn-save-ia-config');
  const mensagemPadrao = textarea?.value?.trim() || '';

  if (!mensagemPadrao) {
    alert('Informe uma mensagem padrao antes de salvar.');
    return;
  }

  btnSave.disabled = true;
  const oldText = btnSave.textContent;
  btnSave.textContent = 'Salvando...';

  try {
    const response = await window.api.updateIaConfig(mensagemPadrao);

    if (!response || response.status === 'error') {
      throw new Error(response?.message || 'Falha ao salvar configuracao da IA');
    }

    alert('Mensagem padrao atualizada com sucesso.');
  } catch (err) {
    console.error('Erro ao atualizar mensagem padrao:', err);
    alert(`Erro ao atualizar mensagem padrao: ${err?.message || err}`);
  } finally {
    btnSave.disabled = false;
    btnSave.textContent = oldText;
  }
}

function showConfigStatus(type, message) {
  const el = document.getElementById('config-save-status');
  if (!el) return;
  el.classList.remove('d-none', 'alert-success', 'alert-danger', 'alert-warning', 'alert-info');
  el.classList.add(type === 'success' ? 'alert-success' : type === 'error' ? 'alert-danger' : 'alert-info');
  el.textContent = message;

  if (type === 'success') {
    setTimeout(() => el.classList.add('d-none'), 4000);
  }
}

function updateConfigInstallHint(tokenValue) {
  const hint = document.getElementById('config-install-hint');
  const btnInstall = document.getElementById('btn-save-and-install');
  if (!hint || !btnInstall) return;

  if (!tokenValue || !tokenValue.trim()) {
    hint.classList.remove('d-none');
    btnInstall.classList.remove('d-none');
  } else {
    hint.classList.add('d-none');
    btnInstall.classList.add('d-none');
  }
}

const cfg_myzap = document.getElementById('myzap-config-form');

cfg_myzap.onsubmit = async (e) => {
  e.preventDefault();
  const btnSave = document.getElementById('btn-save-config');
  const oldText = btnSave.textContent;
  btnSave.disabled = true;
  btnSave.textContent = 'Salvando...';
  const tokenVal = (document.getElementById('input-env-token')?.value || '').trim();
  try {
    const secrets = {
      TOKEN: tokenVal,
      OPENAI_API_KEY: (document.getElementById('input-env-openai')?.value || '').trim(),
      EMAIL_TOKEN: (document.getElementById('input-env-emailtoken')?.value || '').trim()
    };
    const result = await window.api.saveEnvSecrets(secrets);
    if (result?.status === 'success') {
      showConfigStatus('success', '✅ ' + result.message);
      updateConfigInstallHint(tokenVal);
    } else {
      showConfigStatus('error', 'Erro ao salvar: ' + (result?.message || 'desconhecido'));
    }
  } catch (err) {
    showConfigStatus('error', 'Erro ao salvar: ' + (err?.message || err));
  } finally {
    btnSave.disabled = false;
    btnSave.textContent = oldText;
  }
};

async function salvarEInstalar() {
  // 1. Salvar segredos primeiro
  const btnInstall = document.getElementById('btn-save-and-install');
  if (btnInstall) {
    btnInstall.disabled = true;
    btnInstall.innerHTML = `<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Salvando...`;
  }

  const tokenVal = (document.getElementById('input-env-token')?.value || '').trim();
  if (!tokenVal) {
    showConfigStatus('error', 'Preencha o TOKEN antes de instalar.');
    if (btnInstall) { btnInstall.disabled = false; btnInstall.textContent = '🚀 Salvar e Instalar'; }
    return;
  }

  try {
    const secrets = {
      TOKEN: tokenVal,
      OPENAI_API_KEY: (document.getElementById('input-env-openai')?.value || '').trim(),
      EMAIL_TOKEN: (document.getElementById('input-env-emailtoken')?.value || '').trim()
    };
    await window.api.saveEnvSecrets(secrets);
    showConfigStatus('success', '✅ Configurações salvas. Iniciando instalação...');

    if (btnInstall) {
      btnInstall.innerHTML = `<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Instalando...`;
    }

    // Ir para aba Status para acompanhar o progresso
    const statusTab = document.getElementById('status-tab');
    if (statusTab) statusTab.click();

    // Limpar flag de remoção se existir e instalar
    await window.api.clearUserRemovedFlag();
    const autoConfig = await window.api.prepareMyZapAutoConfig(true);
    if (autoConfig?.status === 'error') {
      showConfigStatus('error', 'Erro ao buscar configurações da API: ' + (autoConfig?.message || ''));
      if (btnInstall) { btnInstall.disabled = false; btnInstall.textContent = '🚀 Salvar e Instalar'; }
      return;
    }

    const result = await window.api.ensureMyZapStarted(true);
    if (result?.status === 'success') {
      showConfigStatus('success', '✅ MyZap instalado e iniciado com sucesso!');
      setTimeout(() => window.location.reload(), 2000);
    } else {
      showConfigStatus('error', 'Aviso na instalação: ' + (result?.message || ''));
      if (btnInstall) { btnInstall.disabled = false; btnInstall.textContent = '🚀 Salvar e Instalar'; }
    }
  } catch (err) {
    showConfigStatus('error', 'Erro: ' + (err?.message || err));
    if (btnInstall) { btnInstall.disabled = false; btnInstall.textContent = '🚀 Salvar e Instalar'; }
  }
}

function atualizaStatus() {
  window.location.reload();
}

async function iniciarMyZapServico() {
  const btnStart = document.getElementById('btn-start');
  const statusApi = document.getElementById('status-api');
  const myzap_modoIntegracao = (await window.api.getStore('myzap_modoIntegracao')) ?? 'local';
  const myzap_remoteConfigOk = Boolean(await window.api.getStore('myzap_remoteConfigOk'));

  if (!myzap_remoteConfigOk || !isModoLocal(myzap_modoIntegracao)) {
    statusApi.textContent = !myzap_remoteConfigOk
      ? 'Nao foi possivel validar modo na API. Start local bloqueado.'
      : `Modo web/online: MyZap local desativado. Troque para local/fila no ClickExpress (sync em ate ${CONFIG_SYNC_INTERVAL_MS / 1000}s).`;
    statusApi.className = 'badge bg-info text-dark status-badge';
    btnStart.disabled = true;
    return;
  }

  btnStart.disabled = true;
  statusApi.innerHTML = `
    <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
    Iniciando...
  `;
  statusApi.className = 'badge bg-warning text-dark status-badge';
  try {
    const result = await window.api.ensureMyZapStarted(true);
    statusApi.textContent = result.message || 'Erro ao iniciar MyZap!';
    statusApi.classList.remove('bg-warning', 'text-dark');
    if (result?.status === 'success' && result?.skippedLocalStart) {
      statusApi.classList.add('bg-info', 'text-dark');
      btnStart.disabled = true;
      return;
    }
    statusApi.classList.add(result.status === 'success' ? 'bg-success' : 'bg-danger');
    btnStart.disabled = (result.status === 'success');
  } catch (err) {
    console.error('Erro ao iniciar MyZap:', err);
    statusApi.textContent = 'Erro ao iniciar MyZap!';
    statusApi.classList.remove('bg-warning', 'text-dark');
    statusApi.classList.add('bg-danger');
    btnStart.disabled = false;
  }
}

function setInstalled(isInstalled) {
  const dropdownBtn = document.getElementById("btn-install-dropdown");
  const mainBtn = document.getElementById("btn-install");

  if (isInstalled) {
    dropdownBtn.classList.remove("d-none");
    mainBtn.innerText = "Instalado";
    mainBtn.classList.remove("btn-primary");
    mainBtn.classList.add("btn-success");
    mainBtn.disabled = true;
  } else {
    dropdownBtn.classList.add("d-none");
    mainBtn.innerText = "Instalar";
    mainBtn.classList.remove("btn-success");
    mainBtn.classList.add("btn-primary");
    mainBtn.disabled = false;
  }
}

async function installMyZap() {
  const myzap_diretorio = (await window.api.getStore('myzap_diretorio')) ?? '';
  const myzap_envContent = (await window.api.getStore('myzap_envContent')) ?? '';

  if (!myzap_diretorio) {
    alert('Por favor, salve as configuracoes antes de instalar o MyZap.');
    return;
  }

  // 1. Elementos da UI
  const btnInstall = document.getElementById('btn-install');
  const btnStart = document.getElementById('btn-start');
  const btnRefresh = document.getElementById('btn-refresh-status');
  const statusBadge = document.getElementById('status-installation');

  // Guardamos o texto original para restaurar em caso de erro
  const originalBtnText = btnInstall.innerHTML;
  const originalBadgeText = statusBadge.textContent;
  const originalBadgeClass = statusBadge.className;

  try {
    btnInstall.disabled = true;
    btnStart.disabled = true;
    btnRefresh.disabled = true;

    btnInstall.innerHTML = `
            <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
            Instalando...
        `;

    statusBadge.textContent = 'Baixando arquivos...';
    statusBadge.className = 'badge bg-warning text-dark status-badge';

    const clone = await window.api.cloneRepository(
      String(myzap_diretorio),
      String(myzap_envContent)
    );

    if (clone.status === 'error') {
      throw new Error(clone.message || 'Erro desconhecido');
    }

    statusBadge.textContent = 'MyZap se encontra no diretorio configurado!';
    statusBadge.className = 'badge bg-success status-badge';

    setTimeout(() => {
      alert('MyZap instalado com sucesso!');
      atualizaStatus();
    }, 500);

  } catch (error) {
    console.error(error);
    alert('Erro ao instalar MyZap: ' + error.message);

    btnInstall.innerHTML = originalBtnText;
    btnInstall.disabled = false;

    statusBadge.textContent = 'Falha na instalacao';
    statusBadge.className = 'badge bg-danger status-badge';
  }
}

async function reinstallMyZap() {
  if (!confirm("Deseja reinstalar o MyZap? Isso ira substituir a instalacao atual.")) {
    return;
  }

  const myzap_diretorio = (await window.api.getStore('myzap_diretorio')) ?? '';
  const myzap_envContent = (await window.api.getStore('myzap_envContent')) ?? '';

  if (!myzap_diretorio) {
    alert('Por favor, salve as configuracoes antes de re-instalar o MyZap.');
    return;
  }

  // 1. Elementos da UI
  const btnInstall = document.getElementById('btn-install');
  const btnReInstall = document.getElementById('btn-reinstall');
  const btnStart = document.getElementById('btn-start');
  const btnRefresh = document.getElementById('btn-refresh-status');
  const statusBadge = document.getElementById('status-installation');
  const statusRunBadge = document.getElementById('status-api');
  const dropdownBtn = document.getElementById("btn-install-dropdown");

  // Guardamos o texto original para restaurar em caso de erro
  const originalBtnText = btnInstall.innerHTML;
  const originalBadgeText = statusBadge.textContent;
  const originalBadgeClass = statusBadge.className;

  try {
    btnInstall.disabled = true;
    btnStart.disabled = true;
    btnReInstall.disabled = true;
    dropdownBtn.disabled = true;
    btnRefresh.disabled = true;

    btnInstall.innerHTML = `
            <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
            Re-Instalando...
        `;

    statusBadge.textContent = 'Baixando arquivos...';
    statusBadge.className = 'badge bg-warning text-dark status-badge';

    statusRunBadge.textContent = 'Aguardando reinstalacao...';
    statusRunBadge.className = 'badge bg-secondary status-badge';

    const clone = await window.api.cloneRepository(
      String(myzap_diretorio),
      String(myzap_envContent),
      true
    );

    if (clone.status === 'error') {
      throw new Error(clone.message || 'Erro desconhecido');
    }

    statusBadge.textContent = 'MyZap se encontra no diretorio configurado!';
    statusBadge.className = 'badge bg-success status-badge';

    setTimeout(() => {
      alert('MyZap re-instalado com sucesso!');
      atualizaStatus();
    }, 500);

  } catch (error) {
    console.error(error);
    alert('Erro ao re-instalar MyZap: ' + error.message);

    btnInstall.innerHTML = originalBtnText;
    btnInstall.disabled = false;

    statusBadge.textContent = 'Falha na instalacao';
    statusBadge.className = 'badge bg-danger status-badge';
    setTimeout(() => {
      atualizaStatus();
    }, 1500);
  }
}

// ═══════════════════════════════════════════════════
// REMOVER TUDO (RESET COMPLETO)
// ═══════════════════════════════════════════════════

function setPanelVisible(visible) {
  const tabs = document.getElementById('myzapTabs');
  const tabContent = document.querySelector('.tab-content');
  if (tabs) tabs.classList.toggle('d-none', !visible);
  if (tabContent) tabContent.classList.toggle('d-none', !visible);
}

function setResetFeedback({ show, type, icon, title, message, details, showInstallAgain }) {
  const box = document.getElementById('reset-feedback-box');
  const alertEl = document.getElementById('reset-feedback-alert');
  const iconEl = document.getElementById('reset-feedback-icon');
  const titleEl = document.getElementById('reset-feedback-title');
  const msgEl = document.getElementById('reset-feedback-message');
  const detailsEl = document.getElementById('reset-feedback-details');
  const btnAgain = document.getElementById('btn-install-again');

  if (!box) return;

  if (!show) {
    box.classList.add('d-none');
    return;
  }

  box.classList.remove('d-none');

  alertEl.classList.remove('alert-info', 'alert-success', 'alert-danger', 'alert-warning');
  alertEl.classList.add(type === 'success' ? 'alert-success' : type === 'error' ? 'alert-danger' : type === 'warning' ? 'alert-warning' : 'alert-info');

  iconEl.textContent = icon || '';
  titleEl.textContent = title || '';
  msgEl.textContent = message || '';

  if (details) {
    detailsEl.classList.remove('d-none');
    detailsEl.textContent = details;
  } else {
    detailsEl.classList.add('d-none');
    detailsEl.textContent = '';
  }

  if (showInstallAgain) {
    btnAgain.classList.remove('d-none');
  } else {
    btnAgain.classList.add('d-none');
  }

  // Scroll pro topo para garantir visibilidade
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setAllButtonsDisabled(disabled) {
  const ids = ['btn-start', 'btn-install', 'btn-reinstall', 'btn-install-dropdown', 'btn-refresh-status', 'btn-remove-all', 'btn-start-session', 'btn-delete-session'];
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
  });
}

async function removerTudoMyZap() {
  if (!confirm('Tem certeza que deseja REMOVER TUDO do MyZap local?\n\nIsso ira:\n- Parar o servico do MyZap\n- Remover todos os arquivos instalados\n- Limpar todas as configuracoes salvas\n\nVoce podera reinstalar depois.')) {
    return;
  }

  const btnRemove = document.getElementById('btn-remove-all');
  const originalBtnText = btnRemove ? btnRemove.innerHTML : '';

  try {
    // Desabilitar todos os botoes durante o processo
    setAllButtonsDisabled(true);

    if (btnRemove) {
      btnRemove.innerHTML = `
        <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
        Removendo...
      `;
    }

    // Feedback: processo iniciado
    setResetFeedback({
      show: true,
      type: 'info',
      icon: '',
      title: 'Removendo MyZap local...',
      message: 'Parando servicos, removendo arquivos e limpando configuracoes. Aguarde...',
      details: null,
      showInstallAgain: false
    });

    // Esconder painel durante o processo
    setPanelVisible(false);

    // Chamar o reset no backend
    const result = await window.api.resetEnvironment({ removeTools: false });

    if (!result || result.status === 'error') {
      // Erro — reexibir painel
      setPanelVisible(true);

      setResetFeedback({
        show: true,
        type: 'error',
        icon: '',
        title: 'Erro ao remover MyZap',
        message: result?.message || 'Erro desconhecido durante a remocao.',
        details: result?.data?.warnings?.length ? 'Avisos: ' + result.data.warnings.join('; ') : null,
        showInstallAgain: false
      });

      if (btnRemove) {
        btnRemove.innerHTML = originalBtnText;
        btnRemove.disabled = false;
      }
      return;
    }

    // Sucesso ou warning
    const isWarning = result.status === 'warning';
    const dirResults = result.data?.directories || [];
    const removedDirs = dirResults.filter((d) => d.removed).map((d) => d.path);
    const skippedDirs = dirResults.filter((d) => d.skipped).map((d) => `${d.path} (${d.reason})`);

    let detailsText = '';
    if (removedDirs.length > 0) detailsText += `Diretorios removidos: ${removedDirs.join(', ')}. `;
    if (skippedDirs.length > 0) detailsText += `Diretorios ignorados: ${skippedDirs.join(', ')}. `;
    if (result.data?.warnings?.length) detailsText += `Avisos: ${result.data.warnings.join('; ')}`;

    setResetFeedback({
      show: true,
      type: isWarning ? 'warning' : 'success',
      icon: isWarning ? '' : '',
      title: isWarning ? 'Remocao concluida com avisos' : 'MyZap removido com sucesso!',
      message: result.message,
      details: detailsText.trim() || null,
      showInstallAgain: true
    });

    // Painel continua escondido — so mostra feedback + botao instalar novamente
    if (btnRemove) btnRemove.classList.add('d-none');
    setAllButtonsDisabled(true);

  } catch (err) {
    console.error('Erro ao remover MyZap:', err);

    // Reexibir painel em caso de erro
    setPanelVisible(true);

    setResetFeedback({
      show: true,
      type: 'error',
      icon: '',
      title: 'Erro inesperado',
      message: `Falha ao remover MyZap: ${err?.message || err}`,
      details: null,
      showInstallAgain: false
    });

    if (btnRemove) {
      btnRemove.innerHTML = originalBtnText;
      btnRemove.disabled = false;
    }
  }
}

async function instalarNovamente() {
  const btnAgain = document.getElementById('btn-install-again');
  if (btnAgain) {
    btnAgain.disabled = true;
    btnAgain.innerHTML = `
      <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
      Preparando instalacao...
    `;
  }

  try {
    // Limpar flag que impede auto-install
    await window.api.clearUserRemovedFlag();

    // Verificar TOKEN — gerar automaticamente se estiver vazio
    setResetFeedback({
      show: true,
      type: 'info',
      icon: '',
      title: 'Preparando instalacao...',
      message: 'Verificando configuracoes e TOKEN. Aguarde...',
      details: null,
      showInstallAgain: false
    });

    const envSecrets = await window.api.readEnvSecrets();
    const tokenAtual = (envSecrets?.TOKEN || '').trim();
    if (!tokenAtual) {
      // Gerar token aleatorio de 64 chars hex
      const arr = new Uint8Array(32);
      crypto.getRandomValues(arr);
      const novoToken = Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
      await window.api.saveEnvSecrets({
        TOKEN: novoToken,
        OPENAI_API_KEY: envSecrets?.OPENAI_API_KEY || '',
        EMAIL_TOKEN: envSecrets?.EMAIL_TOKEN || ''
      });
      setResetFeedback({
        show: true,
        type: 'info',
        icon: '',
        title: 'Token gerado automaticamente',
        message: `Novo TOKEN gerado e salvo nas configuracoes: ${novoToken.slice(0, 16)}...`,
        details: 'O TOKEN completo esta salvo em Configuracoes > TOKEN.',
        showInstallAgain: false
      });
      // Aguardar 1.5s para o usuario ver o token gerado
      await new Promise((r) => setTimeout(r, 1500));
    }

    // Forcar refresh da config remota para repopular o store
    setResetFeedback({
      show: true,
      type: 'info',
      icon: '',
      title: 'Reinstalando MyZap...',
      message: 'Buscando configuracoes da API e preparando nova instalacao. Aguarde...',
      details: null,
      showInstallAgain: false
    });

    const autoConfig = await window.api.prepareMyZapAutoConfig(true);

    if (autoConfig?.status === 'error') {
      setResetFeedback({
        show: true,
        type: 'error',
        icon: '',
        title: 'Erro ao buscar configuracoes',
        message: `Nao foi possivel obter configuracoes da API: ${autoConfig?.message || 'erro desconhecido'}. Feche e reabra o painel para tentar novamente.`,
        details: null,
        showInstallAgain: true
      });
      if (btnAgain) {
        btnAgain.disabled = false;
        btnAgain.textContent = 'Instalar Novamente';
      }
      return;
    }

    // Atualizar feedback — agora executando instalacao
    setResetFeedback({
      show: true,
      type: 'info',
      icon: '',
      title: 'Instalando MyZap...',
      message: 'Clonando repositorio, instalando dependencias e iniciando servico. Isso pode levar alguns minutos...',
      details: null,
      showInstallAgain: false
    });

    // Tentar iniciar o processo completo (ensureStarted faz clone + install + start)
    const result = await window.api.ensureMyZapStarted(true);

    if (result?.status === 'success') {
      setResetFeedback({
        show: true,
        type: 'success',
        icon: '',
        title: 'MyZap instalado e iniciado!',
        message: result.message || 'O MyZap foi reinstalado com sucesso. Recarregando painel...',
        details: null,
        showInstallAgain: false
      });

      // Recarregar painel completo apos 2s
      setTimeout(() => {
        window.location.reload();
      }, 2000);
    } else {
      setResetFeedback({
        show: true,
        type: 'warning',
        icon: '',
        title: 'Instalacao com avisos',
        message: result?.message || 'A instalacao pode nao ter completado totalmente.',
        details: result?.message?.includes('TOKEN') || result?.message?.includes('required') || result?.message?.includes('codigo 1')
          ? 'Verifique se o TOKEN esta preenchido: va em Configuracoes > TOKEN e salve a chave do MyZap.'
          : 'Verifique os logs e tente novamente.',
        showInstallAgain: true
      });
      if (btnAgain) {
        btnAgain.disabled = false;
        btnAgain.textContent = 'Instalar Novamente';
      }
    }

  } catch (err) {
    console.error('Erro ao reinstalar MyZap:', err);
    setResetFeedback({
      show: true,
      type: 'error',
      icon: '',
      title: 'Erro ao reinstalar',
      message: `Falha: ${err?.message || err}. Feche e reabra o painel para tentar novamente.`,
      details: null,
      showInstallAgain: true
    });
    if (btnAgain) {
      btnAgain.disabled = false;
      btnAgain.textContent = 'Instalar Novamente';
    }
  }
}
