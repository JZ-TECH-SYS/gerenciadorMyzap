/**
 * Bandeja MINIMALISTA (v3). A regra: a bandeja abre o painel e resolve as 2
 * urgencias reais (pausar envio, buscar atualizacao); todo o resto vive na
 * janela unica — os 10 itens antigos eram cicatrizes de bugs ja corrigidos.
 */

const { Menu, Tray, Notification, nativeImage } = require('electron');

let trayInstance = null;
let actions = null;
let isEnvioAtivo = () => true;
let appVersion = '?.?.?';
let trayIconPath = null;

function buildMenuTemplate(envioAtivo, callbacks) {
  const { openPanel, toggleEnvio, checkAllUpdates } = callbacks;

  return [
    { label: `Gerenciador MyZap  v${appVersion}`, enabled: false },
    { type: 'separator' },
    { label: 'Abrir painel', click: () => openPanel?.() },
    {
      label: envioAtivo ? 'Pausar envio de mensagens' : 'Retomar envio de mensagens',
      click: () => toggleEnvio?.()
    },
    { label: 'Buscar atualizacao', click: () => checkAllUpdates?.() },
    { type: 'separator' },
    { label: 'Sair', role: 'quit' }
  ];
}

function init(iconPath, callbackSet, version = '?.?.?', envioAtivoState) {
  actions = callbackSet;
  appVersion = version;
  trayIconPath = iconPath;

  if (typeof envioAtivoState === 'function') {
    isEnvioAtivo = envioAtivoState;
  }

  trayInstance = new Tray(iconPath);
  trayInstance.setToolTip(`Gerenciador MyZap  v${version}`);
  trayInstance.on('double-click', () => actions?.openPanel?.());
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

  const menu = Menu.buildFromTemplate(buildMenuTemplate(isEnvioAtivo(), actions));
  trayInstance.setContextMenu(menu);
}

module.exports = {
  init,
  rebuildMenu,
  notify
};
