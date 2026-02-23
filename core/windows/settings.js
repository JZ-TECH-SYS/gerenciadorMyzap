const { BrowserWindow } = require('electron');
const path = require('path');

let settingsWin = null;

function createSettings() {
  if (settingsWin) {
    settingsWin.focus();
    return;
  }

  settingsWin = new BrowserWindow({
    width: 640,
    height: 640,
    resizable: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../../src/loads/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  settingsWin.loadFile(path.join(__dirname, '../../assets/html/settings.html'));
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

module.exports = { createSettings };
