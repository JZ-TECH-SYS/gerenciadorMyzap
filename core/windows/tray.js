const { Menu, Tray } = require('electron');

let trayInstance = null;
let actions = null;
let getMyzapStatus = () => false;
let appVersion = '?.?.?';

function buildMenuTemplate(myzapAtivo, callbacks) {
  const {
    createSettings,
    toggleMyzap,
    updateMyZapNow,
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

  if (typeof myzapStatusState === 'function') {
    getMyzapStatus = myzapStatusState;
  }

  trayInstance = new Tray(iconPath);
  trayInstance.setToolTip(`Gerenciador MyZap  v${version}`);
  rebuildMenu();
  return trayInstance;
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
  rebuildMenu
};
