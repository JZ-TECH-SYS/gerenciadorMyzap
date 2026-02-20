const { app } = require('electron');
const log = require('electron-log');
const { info, warn, error } = require('./utils/logger');

function attachAutoUpdaterHandlers(autoUpdater, callbacks = {}) {
  const { toast } = callbacks;

  autoUpdater.logger = log;
  autoUpdater.logger.transports.file.level = 'info';
  log.info('AutoUpdater logger configurado');

  autoUpdater.on('update-available', () => {
    toast?.('Atualização encontrada, baixando agora...');
    info('AutoUpdater encontrou nova versão', { metadata: { action: 'update-available' } });
  });

  autoUpdater.on('update-not-available', () => {
    toast?.('Nenhuma atualização disponível no momento.');
    info('AutoUpdater não encontrou novas versões', { metadata: { action: 'update-not-available' } });
  });

  autoUpdater.on('error', (err) => {
    error('AutoUpdater falhou', { metadata: { error: err } });
    toast?.('Erro ao buscar atualizações.');
  });

  autoUpdater.on('update-downloaded', () => {
    info('Atualização baixada e aguardando instalação', {
      metadata: { action: 'update-downloaded' }
    });
    toast?.('Atualização baixada. Aplicando agora...');
    try {
      autoUpdater.quitAndInstall();
    } catch (err) {
      warn('Falha ao aplicar atualização automaticamente', { metadata: { error: err } });
      toast?.('Não foi possível aplicar a atualização automaticamente.');
    }
  });
}

function checkForUpdates(autoUpdater, callbacks = {}) {
  const { toast } = callbacks;

  if (!app.isPackaged) {
    toast?.('Atualização automática só funciona na versão instalada.');
    log.info('AutoUpdater ignorado (app não empacotado)');
    return;
  }

  try {
    toast?.('Buscando atualizações...');
    log.info('Disparando checkForUpdatesAndNotify');
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      error('AutoUpdater falhou durante o check', { metadata: { error: err } });
      toast?.('Erro ao buscar atualizações (veja os logs).');
    });
  } catch (err) {
    warn('Falha ao iniciar busca de atualizações', { metadata: { error: err } });
    toast?.('Erro ao iniciar busca de atualizações.');
  }
}

module.exports = { attachAutoUpdaterHandlers, checkForUpdates };
