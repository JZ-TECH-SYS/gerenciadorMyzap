const { BrowserWindow } = require('electron');
const path = require('path');

let win = null;

function openLogViewer() {
  if (win) {
    win.focus();
    return;
  }

  win = new BrowserWindow({
    width: 600,
    height: 500,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, '../../src/loads/preloadLog.js'),
      contextIsolation: true,
      sandbox: false
    }
  });

  win.loadFile(path.join(__dirname, '../../assets/html/logs.html'));

  win.on('closed', () => (win = null));
}

module.exports = { openLogViewer };
