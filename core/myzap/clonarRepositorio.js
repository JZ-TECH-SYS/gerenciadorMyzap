const { spawn } = require('child_process');
const fs = require('fs');
const { error: logError, warn, info } = require('./myzapLogger');
const {
  killProcessesOnPort,
  getPnpmCommand,
  getPrivilegeStatus,
  buildAdminRequiredMessage,
} = require('./processUtils');
const { iniciarMyZap } = require('./iniciarMyZap');
const { syncMyZapConfigs } = require('./syncConfigs');
const { transition } = require('./stateMachine');
const { downloadRepositoryArchive } = require('./repositoryArchive');

function getErrorMessage(error) {
  return error && error.message ? error.message : String(error);
}

function rodarComando(executor, args, opcoes = {}) {
  return new Promise((resolve) => {
    const runner = (typeof executor === 'string')
      ? {
        command: executor,
        prefixArgs: [],
        shell: true,
        env: process.env,
        source: executor,
      }
      : {
        prefixArgs: [],
        shell: false,
        env: process.env,
        source: executor && executor.command ? executor.command : undefined,
        ...executor,
      };
    const proc = spawn(runner.command, [...runner.prefixArgs, ...args], {
      shell: runner.shell,
      env: runner.env,
      windowsHide: true,
      ...opcoes,
    });
    const commandLabel = runner.source || runner.command;

    proc.stdout.on('data', (data) => {
      info('MyZap comando stdout', {
        metadata: {
          area: 'clonarRepositorio',
          comando: commandLabel,
          output: String(data).trim(),
        },
      });
    });
    proc.stderr.on('data', (data) => {
      warn('MyZap comando stderr', {
        metadata: {
          area: 'clonarRepositorio',
          comando: commandLabel,
          output: String(data).trim(),
        },
      });
    });

    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

async function clonarRepositorio(dirPath, envContent, reinstall = false, options = {}) {
  try {
    const reportProgress = (typeof options.onProgress === 'function')
      ? options.onProgress
      : () => {};

    const privilegeStatus = getPrivilegeStatus();
    if (privilegeStatus.requiresAdminForLocalInstall && !privilegeStatus.isElevated) {
      const message = buildAdminRequiredMessage(
        reinstall ? 'reinstalar o MyZap local' : 'instalar o MyZap local',
      );

      warn('Instalacao local do MyZap bloqueada por falta de privilegios de administrador', {
        metadata: {
          area: 'clonarRepositorio',
          dirPath,
          reinstall,
          privilegeStatus,
        },
      });

      reportProgress(message, 'admin_required', {
        dirPath,
        reinstall,
        privilegeStatus,
        percent: 100,
      });
      transition('error', {
        message,
        dirPath,
        reinstall,
        privilegeStatus,
      });

      return {
        status: 'error',
        requiresAdmin: true,
        privilegeStatus,
        message,
      };
    }

    reportProgress('Preparando instalacao automatica do MyZap...', 'precheck', {
      percent: 10,
      dirPath,
    });

    transition('checking_config', { message: 'Preparando instalacao automatica do MyZap...', dirPath });

    const pnpmRunner = await getPnpmCommand();
    if (!pnpmRunner) {
      return {
        status: 'error',
        message: 'Nao foi possivel carregar o instalador interno de dependencias do MyZap.',
      };
    }

    info('Runner de dependencias selecionado para instalacao do MyZap', {
      metadata: {
        area: 'clonarRepositorio',
        runnerSource: pnpmRunner.source || pnpmRunner.command,
        dirPath,
      },
    });

    if (reinstall) {
      reportProgress('Reinstalacao solicitada. Limpando instalacao anterior...', 'reinstall_cleanup', {
        percent: 20,
        dirPath,
      });
      info('Iniciando modo de reinstalacao do MyZap', { metadata: { dirPath } });

      const killResult = killProcessesOnPort(5555);
      if (killResult.failed.length > 0) {
        warn('Nao foi possivel finalizar alguns processos na porta 5555', {
          metadata: { failed: killResult.failed },
        });
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 500);
      });

      if (fs.existsSync(dirPath)) {
        try {
          fs.rmSync(dirPath, { recursive: true, force: true });
        } catch (err) {
          logError('Erro ao remover pasta do MyZap na reinstalacao', { metadata: { err, dirPath } });
          return {
            status: 'error',
            message: `Falha ao remover diretorio atual do MyZap: ${err.message}`,
          };
        }
      }
    }

    transition('cloning_repo', { message: 'Baixando pacote do MyZap...', dirPath });

    try {
      await downloadRepositoryArchive(dirPath, {
        onProgress: reportProgress,
      });
    } catch (archiveErr) {
      logError('Falha ao baixar o pacote do MyZap para instalacao local', {
        metadata: {
          area: 'clonarRepositorio',
          dirPath,
          error: archiveErr,
        },
      });
      return {
        status: 'error',
        message: getErrorMessage(archiveErr) || 'Erro ao baixar o pacote do MyZap para instalacao local.',
      };
    }

    transition('installing_dependencies', { message: 'Instalando dependencias do MyZap...', dirPath });

    reportProgress('Instalando dependencias do MyZap...', 'install_dependencies', {
      percent: 55,
      dirPath,
    });
    const instalouDeps = await rodarComando(
      pnpmRunner,
      ['install'],
      { cwd: dirPath },
    );

    if (!instalouDeps) {
      return {
        status: 'error',
        message: 'Pacote do MyZap baixado, mas houve erro ao instalar as dependencias locais.',
      };
    }

    reportProgress('Aplicando configuracoes locais (.env e banco base)...', 'sync_configs', {
      percent: 75,
      dirPath,
    });
    const syncResult = syncMyZapConfigs(dirPath, {
      envContent,
      overwriteDb: true,
    });

    if (syncResult.status === 'error') {
      return syncResult;
    }

    reportProgress('Iniciando servico local do MyZap...', 'start_service', {
      percent: 88,
      dirPath,
    });
    const startResult = await iniciarMyZap(dirPath, {
      onProgress: reportProgress,
    });
    if (startResult && startResult.status === 'error') {
      return startResult;
    }

    reportProgress('MyZap local iniciado. Finalizando ajustes...', 'start_confirmed', {
      percent: 95,
      dirPath,
    });
    return {
      status: 'success',
      message: 'MyZap instalado, configurado e iniciado com sucesso!',
    };
  } catch (err) {
    transition('error', { message: getErrorMessage(err), phase: 'clone_install' });
    logError('Erro critico no processo de instalacao', { metadata: { error: err } });
    return { status: 'error', message: `Erro: ${err.message}` };
  }
}

module.exports = clonarRepositorio;
