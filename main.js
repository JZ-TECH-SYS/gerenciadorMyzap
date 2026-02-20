/* ─── Main process ──────────────────────────────────────────────────── */
const {
  app,
  Notification,
  ipcMain
} = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const Store = require('electron-store');

const { info, warn, error, abrirPastaLogs } = require('./core/utils/logger');
const { startWhatsappQueueWatcher, stopWhatsappQueueWatcher } = require('./core/api/whatsappQueueWatcher');
const { startMyzapStatusWatcher, stopMyzapStatusWatcher } = require('./core/api/myzapStatusWatcher');
const { createPainelMyZap } = require('./core/windows/painelMyZap');
const { createFilaMyZap } = require('./core/windows/filaMyZap');
const { openLogViewer } = require('./core/windows/logViewer');
const trayManager = require('./core/windows/tray');
const { registerMyZapHandlers } = require('./core/ipc/myzap');
const { attachAutoUpdaterHandlers, checkForUpdates } = require('./core/updater');
const verificarDiretorio = require('./core/myzap/verificarDiretorio');
const atualizarEnv = require('./core/myzap/atualizarEnv');

/* ---------- store ---------- */
const store = new Store({
  defaults: {
    myzap_diretorio: '',
    myzap_sessionKey: '',
    myzap_apiToken: '',
    myzap_envContent: '',
    clickexpress_apiUrl: '',
    clickexpress_queueToken: ''
  }
});

/* ---------- estado ---------- */
let queueAutoStartTimer = null;

/* =========================================================
   1. Utilitários
========================================================= */
function toast(msg) {
  new Notification({
    title: 'Gerenciador MyZap',
    body: msg,
    icon: path.join(__dirname, 'assets/icon.png')
  }).show();
}

function hasValidConfigMyZap() {
  return (
    !!store.get('myzap_diretorio') &&
    !!store.get('myzap_sessionKey') &&
    !!store.get('myzap_apiToken') &&
    !!store.get('myzap_envContent')
  );
}

function handleUpdateCheck() {
  checkForUpdates(autoUpdater, { toast, warn });
}

async function autoStartMyZap() {
  const diretorio = store.get('myzap_diretorio');
  const envContent = store.get('myzap_envContent');

  info('Auto-start MyZap iniciado', { metadata: { diretorio } });

  if (!hasValidConfigMyZap()) {
    warn('MyZap: Configurações ausentes — abrindo painel de configuração.');
    createPainelMyZap();
    return;
  }

  try {
    const checkDir = await verificarDiretorio(diretorio);

    if (checkDir.status !== 'success') {
      warn('MyZap: Diretório vazio ou inválido.', { metadata: { diretorio } });
      createPainelMyZap();
      return;
    }

    info('MyZap: Reiniciando serviço automaticamente...');
    const result = await atualizarEnv(diretorio, envContent);

    if (result.status === 'success') {
      toast('Serviço MyZap reiniciado automaticamente');
      info('MyZap: Serviço reiniciado com sucesso.');
    } else {
      error('MyZap: Falha ao reiniciar automaticamente', { metadata: { result } });
      createPainelMyZap();
    }
  } catch (err) {
    error('MyZap: Erro crítico no auto-start', { metadata: { error: err } });
    createPainelMyZap();
  }
}

async function tryStartQueueWatcherAuto() {
  try {
    const result = await startWhatsappQueueWatcher();
    if (result?.status === 'success') {
      if (queueAutoStartTimer) {
        clearInterval(queueAutoStartTimer);
        queueAutoStartTimer = null;
      }
      info('Watcher da fila MyZap iniciado automaticamente', {
        metadata: { trigger: 'inicializacao', message: result?.message }
      });
      return true;
    }

    warn('Fila MyZap ainda não iniciada automaticamente', {
      metadata: { message: result?.message || 'resultado sem mensagem' }
    });
    return false;
  } catch (err) {
    warn('Erro ao iniciar automaticamente o watcher da fila MyZap', {
      metadata: { error: err }
    });
    return false;
  }
}

function scheduleQueueAutoStart() {
  if (queueAutoStartTimer) return;

  tryStartQueueWatcherAuto();
  queueAutoStartTimer = setInterval(() => {
    tryStartQueueWatcherAuto();
  }, 30000);
}

attachAutoUpdaterHandlers(autoUpdater, { toast });

/* =========================================================
   2. App ready
========================================================= */
app.whenReady().then(() => {
  info('Aplicação pronta para uso', {
    metadata: { ambiente: app.isPackaged ? 'producao' : 'desenvolvimento' }
  });

  trayManager.init(
    path.join(__dirname, 'assets/icon.png'),
    {
      createPainelMyZap,
      createFilaMyZap,
      openLogViewer,
      abrirPastaLogs,
      checkUpdates: handleUpdateCheck
    },
    app.getVersion()
  );

  // Sempre abre o painel na primeira configuração
  if (!hasValidConfigMyZap()) {
    warn('Configuração do MyZap ausente — abrindo painel.', {
      metadata: {
        myzap_diretorio: !!store.get('myzap_diretorio'),
        myzap_sessionKey: !!store.get('myzap_sessionKey')
      }
    });
    createPainelMyZap();
  } else {
    autoStartMyZap();
  }

  scheduleQueueAutoStart();
  startMyzapStatusWatcher();

  handleUpdateCheck();
});

/* =========================================================
   3. Janelas nunca fecham o app (fica só no tray)
========================================================= */
app.on('window-all-closed', (e) => e.preventDefault());

app.on('before-quit', () => {
  if (queueAutoStartTimer) {
    clearInterval(queueAutoStartTimer);
    queueAutoStartTimer = null;
  }
  stopWhatsappQueueWatcher();
  stopMyzapStatusWatcher();
});

/* =========================================================
   4. IPC handlers
========================================================= */
ipcMain.handle('settings:get', (_e, key) => store.get(key));

registerMyZapHandlers(ipcMain);

/* Quando o usuário salva configurações do MyZap */
ipcMain.on('myzap-settings-saved', (_e, payload) => {
  const {
    myzap_diretorio,
    myzap_sessionKey,
    myzap_apiToken,
    myzap_envContent,
    myzap_mensagemPadrao,
    clickexpress_apiUrl,
    clickexpress_queueToken
  } = payload;

  info('Configurações do MyZap salvas pelo usuário', {
    metadata: { myzap_diretorio, myzap_sessionKey }
  });

  store.set({
    myzap_diretorio,
    myzap_sessionKey,
    myzap_apiToken,
    myzap_envContent,
    myzap_mensagemPadrao,
    clickexpress_apiUrl,
    clickexpress_queueToken
  });
});

/* Tratamento global de erros */
process.on('uncaughtException', (err) => {
  error('uncaughtException', { metadata: { error: err } });
});

process.on('unhandledRejection', (reason) => {
  error('unhandledRejection', { metadata: { error: reason } });
});
