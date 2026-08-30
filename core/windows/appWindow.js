/**
 * Janela ÚNICA do Gerenciador (v3) — substitui as 3 janelas antigas
 * (painel, fila e configurações) por uma só com abas: Início (semáforo),
 * WhatsApp, Mensagens, Configurações e Ajuda.
 */

const { BrowserWindow } = require('electron');
const path = require('path');

let win = null;

/**
 * @param {string} [tab] aba inicial: inicio | whatsapp | mensagens | config | ajuda
 */
function createAppWindow(tab = '') {
    if (win && !win.isDestroyed()) {
        win.show();
        win.focus();
        if (tab) {
            win.webContents.send('app:goto-tab', tab);
        }
        return win;
    }

    win = new BrowserWindow({
        width: 1024,
        height: 720,
        minWidth: 860,
        minHeight: 600,
        autoHideMenuBar: true,
        backgroundColor: '#12181a',
        webPreferences: {
            preload: path.join(__dirname, '../../src/loads/preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    });

    const query = tab ? { tab } : {};
    win.loadFile(path.join(__dirname, '../../assets/html/app.html'), { query });
    win.on('closed', () => {
        win = null;
    });

    return win;
}

function getAppWindow() {
    return (win && !win.isDestroyed()) ? win : null;
}

module.exports = { createAppWindow, getAppWindow };
