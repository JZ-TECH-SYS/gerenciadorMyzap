/* ─── Tray (apenas MyZap) ──────────────────────────────────────────── */
const { Menu, Tray } = require('electron');

let trayInstance = null;
let actions = null;
let appVersion = '?.?.?';

function buildMenuTemplate(callbacks) {
  const {
    createPainelMyZap,
    createFilaMyZap,
    openLogViewer,
    abrirPastaLogs,
    checkUpdates
  } = callbacks;

  return [
    {
      label: '💬 WhatsApp',
      enabled: false
    },
    { label: '🔗 Painel MyZap', click: createPainelMyZap },
    { label: '📬 Fila MyZap', click: createFilaMyZap },
    { type: 'separator' },
    { label: '📄 Ver Logs', click: openLogViewer },
    { label: '📁 Abrir Pasta de Logs', click: abrirPastaLogs },
    { type: 'separator' },
    {
      label: `Versão ${appVersion}`,
      click: () => checkUpdates?.(),
      enabled: !!checkUpdates
    },
    { label: '🚪 Sair', role: 'quit' }
  ];
}

function init(iconPath, callbackSet, version = '?.?.?') {
  actions = callbackSet;
  appVersion = version;

  trayInstance = new Tray(iconPath);
  trayInstance.setToolTip('Gerenciador MyZap');
  rebuildMenu();
  return trayInstance;
}

function rebuildMenu() {
  if (!trayInstance || !actions) return;
  const menu = Menu.buildFromTemplate(buildMenuTemplate(actions));
  trayInstance.setContextMenu(menu);
}

module.exports = { init, rebuildMenu };
