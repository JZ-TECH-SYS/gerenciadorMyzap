const { app } = require('electron');
const log = require('electron-log');
const { info, warn, error } = require('./utils/logger');

// Espera educada antes do quitAndInstall: nao derrubar o app no MEIO de um
// lote de disparo (mensagens ficavam presas em 'processando' no backend).
const INSTALL_RETRY_MS = 15 * 1000;
const INSTALL_DEADLINE_MS = 10 * 60 * 1000;

function attachAutoUpdaterHandlers(autoUpdater, callbacks = {}) {
  const { toast, getQueueStatus } = callbacks;
  let installScheduled = false;

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

    if (installScheduled) {
      return;
    }
    installScheduled = true;

    const deadline = Date.now() + INSTALL_DEADLINE_MS;
    let avisouEspera = false;

    const instalarAgora = () => {
      try {
        autoUpdater.quitAndInstall();
      } catch (err) {
        warn('Falha ao aplicar atualização automaticamente', { metadata: { error: err } });
        toast?.('Não foi possível aplicar a atualização automaticamente.');
        installScheduled = false;
      }
    };

    const tentarInstalar = () => {
      let filaOcupada = false;
      try {
        const status = (typeof getQueueStatus === 'function') ? getQueueStatus() : null;
        filaOcupada = Boolean(status?.processando);
      } catch (_e) {
        filaOcupada = false;
      }

      if (!filaOcupada || Date.now() >= deadline) {
        toast?.('Atualização baixada. Aplicando agora...');
        instalarAgora();
        return;
      }

      if (!avisouEspera) {
        avisouEspera = true;
        toast?.('Atualização baixada. Aguardando o fim do lote de envio para aplicar...');
        info('AutoUpdater aguardando fila ociosa para instalar', {
          metadata: { action: 'update-downloaded', deadlineEmMs: INSTALL_DEADLINE_MS }
        });
      }

      setTimeout(tentarInstalar, INSTALL_RETRY_MS);
    };

    tentarInstalar();
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
