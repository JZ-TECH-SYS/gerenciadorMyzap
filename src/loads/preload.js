/* preload.js — Expõe apenas as APIs do MyZap ao renderer */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Config store
  getStore: (key) => ipcRenderer.invoke('settings:get', key),

  // Salvar configurações do MyZap
  send: (channel, data) => ipcRenderer.send(channel, data),
  on: (channel, func) => ipcRenderer.on(channel, (_event, ...args) => func(...args)),

  // Instalação e diretório
  checkDirectoryHasFiles: (dirPath) => ipcRenderer.invoke('myzap:checkDirectoryHasFiles', dirPath),
  cloneRepository: (dirPath, envContent, reinstall = false) =>
    ipcRenderer.invoke('myzap:cloneRepository', dirPath, envContent, reinstall),

  // Ciclo de vida do serviço MyZap
  iniciarMyZap: (dirPath) => ipcRenderer.invoke('myzap:iniciarMyZap', dirPath),

  // Sessão WhatsApp
  getConnectionStatus: () => ipcRenderer.invoke('myzap:getConnectionStatus'),
  verifyRealStatus: () => ipcRenderer.invoke('myzap:verifyRealStatus'),
  startSession: () => ipcRenderer.invoke('myzap:startSession'),
  deleteSession: () => ipcRenderer.invoke('myzap:deleteSession'),

  // Configuração de IA
  updateIaConfig: (mensagemPadrao) => ipcRenderer.invoke('myzap:updateIaConfig', mensagemPadrao),

  // Fila de mensagens
  startQueueWatcher: () => ipcRenderer.invoke('myzap:startQueueWatcher'),
  stopQueueWatcher: () => ipcRenderer.invoke('myzap:stopQueueWatcher'),
  getQueueWatcherStatus: () => ipcRenderer.invoke('myzap:getQueueWatcherStatus'),
  getQueuePendentes: () => ipcRenderer.invoke('myzap:getQueuePendentes')
});
