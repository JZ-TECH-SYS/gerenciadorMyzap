const { Menu, Tray, Notification, nativeImage } = require('electron');

let trayInstance = null;
let actions = null;
let getMyzapStatus = () => false;
let appVersion = '?.?.?';
let trayIconPath = null;

function buildMenuTemplate(myzapAtivo, callbacks) {
  const {
    createSettings,
    toggleMyzap,
    updateMyZapNow,
    repararMyZapAgora,
    createPainelMyZap,
    createFilaMyZap,
    openLogViewer,
    abrirPastaLogs,
    checkUpdates
  } = callbacks;

  return [
    { label: '📱  Gerenciador MyZap', enabled: false },
    { label: `      v${appVersion}`, enabled: false },
    { type: 'separator' },
    { label: '── MyZap ──', enabled: false },
    {
      label: myzapAtivo ? '🟢  MyZap ativo' : '🔴  MyZap pausado',
      click: toggleMyzap
    },
    {
      label: '🛠️  Reparar MyZap agora',
      click: () => repararMyZapAgora?.(),
      enabled: !!repararMyZapAgora
    },
    { label: '🔄  Atualizar MyZap agora', click: updateMyZapNow },
    { label: '💬  Painel MyZap', click: createPainelMyZap },
    { label: '📬  Fila de mensagens', click: createFilaMyZap },
    { type: 'separator' },
    { label: '── Sistema ──', enabled: false },
    { label: '⚙️  Configuracoes da API', click: createSettings },
    { label: '📋  Ver logs', click: openLogViewer },
    { label: '📁  Abrir pasta de logs', click: abrirPastaLogs },
    {
      label: '🔎  Verificar atualizacao',
      click: () => checkUpdates?.(),
      enabled: !!checkUpdates
    },
    { type: 'separator' },
    { label: '🚪  Sair', role: 'quit' }
  ];
}

function init(iconPath, callbackSet, version = '?.?.?', myzapStatusState) {
  actions = callbackSet;
  appVersion = version;
  trayIconPath = iconPath;

  if (typeof myzapStatusState === 'function') {
    getMyzapStatus = myzapStatusState;
  }

  trayInstance = new Tray(iconPath);
  trayInstance.setToolTip(`Gerenciador MyZap  v${version}`);
  rebuildMenu();
  return trayInstance;
}

/**
 * Notificacao para o usuario a partir da bandeja: balao nativo no Windows,
 * Notification do Electron nas demais plataformas (ou se o balao falhar).
 */
function notify(message, title = 'Gerenciador MyZap') {
  const body = String(message || '').trim();
  if (!body) {
    return;
  }

  if (process.platform === 'win32' && trayInstance) {
    try {
      trayInstance.displayBalloon({
        title,
        content: body,
        icon: trayIconPath ? nativeImage.createFromPath(trayIconPath) : undefined
      });
      return;
    } catch (_e) { /* cai no fallback */ }
  }

  try {
    new Notification({ title, body, icon: trayIconPath || undefined }).show();
  } catch (_e) { /* melhor esforco */ }
}

function rebuildMenu() {
  if (!trayInstance || !actions) {
    return;
  }

  const menu = Menu.buildFromTemplate(buildMenuTemplate(getMyzapStatus(), actions));
  trayInstance.setContextMenu(menu);
}

module.exports = {
  init,
  rebuildMenu,
  notify
};
