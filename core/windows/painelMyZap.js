const { BrowserWindow } = require("electron");
const path = require("path");

let settingsWin = null;

function createPainelMyZap() {
  if (settingsWin) {
    settingsWin.focus();
    return;
  }

  settingsWin = new BrowserWindow({
    width: 800,
    height: 900,
    resizable: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "../../src/loads/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  settingsWin.loadFile(path.join(__dirname, "../../assets/html/painelMyZap.html"));

  settingsWin.on("closed", () => {
    settingsWin = null;
  });
}

module.exports = { createPainelMyZap };