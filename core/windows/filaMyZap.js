const { BrowserWindow } = require("electron");
const path = require("path");

let filaWin = null;

function createFilaMyZap() {
  if (filaWin) {
    filaWin.focus();
    return;
  }

  filaWin = new BrowserWindow({
    width: 980,
    height: 820,
    resizable: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "../../src/loads/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  filaWin.loadFile(path.join(__dirname, "../../assets/html/filaMyZap.html"));

  filaWin.on("closed", () => {
    filaWin = null;
  });
}

module.exports = { createFilaMyZap };
