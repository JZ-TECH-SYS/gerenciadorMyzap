const { warn } = require('../utils/logger');
const clonarRepositorio = require('../myzap/clonarRepositorio');
const verificarDiretorio = require('../myzap/verificarDiretorio');
const getConnectionStatus = require('../myzap/api/getConnectionStatus');
const startSession = require('../myzap/api/startSession');
const deleteSession = require('../myzap/api/deleteSession');
const verifyRealStatus = require('../myzap/api/verifyRealStatus');
const updateIaConfig = require('../myzap/api/updateIaConfig');
const iniciarMyZap = require('../myzap/iniciarMyZap');
const {
  getUltimosPendentesMyZap,
  startWhatsappQueueWatcher,
  stopWhatsappQueueWatcher,
  getWhatsappQueueWatcherStatus
} = require('../api/whatsappQueueWatcher');

function registerMyZapHandlers(ipcMain) {
  ipcMain.handle('myzap:checkDirectoryHasFiles', async (_e, dirPath) => {
    try {
      return await verificarDiretorio(dirPath);
    } catch (err) {
      warn('Falha ao verificar diretório via IPC', { metadata: { error: err } });
      return { status: 'error', message: err.message || String(err) };
    }
  });

  ipcMain.handle('myzap:cloneRepository', async (_e, dirPath, envContent, reinstall = false) => {
    try {
      return await clonarRepositorio(dirPath, envContent, reinstall);
    } catch (err) {
      warn('Falha ao clonar repositório via IPC', { metadata: { error: err } });
      return { status: 'error', message: err.message || String(err) };
    }
  });

  ipcMain.handle('myzap:iniciarMyZap', async (_e, dirPath) => {
    try {
      return await iniciarMyZap(dirPath);
    } catch (err) {
      warn('Falha ao iniciar MyZap via IPC', { metadata: { error: err } });
      return { status: 'error', message: err.message || String(err) };
    }
  });

  ipcMain.handle('myzap:getConnectionStatus', async () => {
    try {
      return await getConnectionStatus();
    } catch (err) {
      warn('Falha ao verificar conexão MyZap via IPC', { metadata: { error: err } });
      return { status: 'error', message: err.message || String(err) };
    }
  });

  ipcMain.handle('myzap:verifyRealStatus', async () => {
    try {
      return await verifyRealStatus();
    } catch (err) {
      warn('Falha ao verificar status real MyZap via IPC', { metadata: { error: err } });
      return { status: 'error', message: err.message || String(err) };
    }
  });

  ipcMain.handle('myzap:startSession', async () => {
    try {
      return await startSession();
    } catch (err) {
      warn('Falha ao iniciar sessão MyZap via IPC', { metadata: { error: err } });
      return { status: 'error', message: err.message || String(err) };
    }
  });

  ipcMain.handle('myzap:deleteSession', async () => {
    try {
      return await deleteSession();
    } catch (err) {
      warn('Falha ao encerrar sessão MyZap via IPC', { metadata: { error: err } });
      return { status: 'error', message: err.message || String(err) };
    }
  });

  ipcMain.handle('myzap:updateIaConfig', async (_e, mensagemPadrao) => {
    try {
      return await updateIaConfig(mensagemPadrao);
    } catch (err) {
      warn('Falha ao atualizar configuração de IA MyZap via IPC', { metadata: { error: err } });
      return { status: 'error', message: err.message || String(err) };
    }
  });

  ipcMain.handle('myzap:startQueueWatcher', async () => {
    try {
      return await startWhatsappQueueWatcher();
    } catch (err) {
      warn('Falha ao iniciar watcher de fila MyZap via IPC', { metadata: { error: err } });
      return { status: 'error', message: err.message || String(err) };
    }
  });

  ipcMain.handle('myzap:stopQueueWatcher', async () => {
    try {
      return stopWhatsappQueueWatcher();
    } catch (err) {
      warn('Falha ao parar watcher de fila MyZap via IPC', { metadata: { error: err } });
      return { status: 'error', message: err.message || String(err) };
    }
  });

  ipcMain.handle('myzap:getQueueWatcherStatus', async () => {
    try {
      return getWhatsappQueueWatcherStatus();
    } catch (err) {
      warn('Falha ao obter status do watcher de fila MyZap via IPC', { metadata: { error: err } });
      return {
        ativo: false,
        processando: false,
        ultimoLote: 0,
        ultimaExecucaoEm: null,
        ultimoErro: err.message || String(err)
      };
    }
  });

  ipcMain.handle('myzap:getQueuePendentes', async () => {
    try {
      return getUltimosPendentesMyZap();
    } catch (err) {
      warn('Falha ao obter pendentes da fila MyZap via IPC', { metadata: { error: err } });
      return [];
    }
  });
}

module.exports = { registerMyZapHandlers };
