const { spawn } = require('child_process');
const fs = require('fs');
const { error: logError, warn, info } = require('./myzapLogger');
const {
  getPnpmCommand,
  getPrivilegeStatus,
  buildAdminRequiredMessage,
  canWriteToDir,
  envWithNodeShim,
} = require('./processUtils');
const { iniciarMyZap, stopMyZapAndFreePort } = require('./iniciarMyZap');
const opLock = require('./opLock');
const { fetchRemoteMainSha, setInstalledSha } = require('./updateChecker');
const { syncMyZapConfigs } = require('./syncConfigs');
const { transition } = require('./stateMachine');
const { downloadRepositoryArchive } = require('./repositoryArchive');

// Watchdog do install: 15 min sem terminar => mata o processo (rede/registro travado).
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

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
      // shim de `node` no PATH: scripts de lifecycle das deps que chamam `node`
      // funcionam mesmo sem Node instalado na maquina (usa o Electron como Node).
      env: envWithNodeShim(runner.env),
      windowsHide: true,
      ...opcoes,
    });
    const commandLabel = runner.source || runner.command;

    // Watchdog: se o spawn nao terminar em INSTALL_TIMEOUT_MS, mata o processo.
    // O kill dispara 'close'/'error', que resolvem a Promise (e limpam o timer).
    const watchdog = setTimeout(() => {
      warn('Timeout no comando do MyZap: encerrando processo travado', {
        metadata: {
          area: 'clonarRepositorio',
          comando: commandLabel,
          timeoutMs: INSTALL_TIMEOUT_MS,
        },
      });
      proc.kill();
    }, INSTALL_TIMEOUT_MS);

    proc.stdout.on('data', (data) => {
      // Output do comando = progresso real: alimenta o heartbeat do lock para
      // um install longo nao ser tratado como operacao travada.
      opLock.touch();
      info('MyZap comando stdout', {
        metadata: {
          area: 'clonarRepositorio',
          comando: commandLabel,
          output: String(data).trim(),
        },
      });
    });
    proc.stderr.on('data', (data) => {
      opLock.touch();
      warn('MyZap comando stderr', {
        metadata: {
          area: 'clonarRepositorio',
          comando: commandLabel,
          output: String(data).trim(),
        },
      });
    });

    proc.on('close', (code) => {
      clearTimeout(watchdog);
      resolve(code === 0);
    });
    proc.on('error', () => {
      clearTimeout(watchdog);
      resolve(false);
    });
  });
}

async function clonarRepositorio(dirPath, envContent, reinstall = false, options = {}) {
  try {
    const reportProgress = (typeof options.onProgress === 'function')
      ? options.onProgress
      : () => {};

    const privilegeStatus = getPrivilegeStatus();
    // So exige admin se a pasta de instalacao NAO for gravavel pelo usuario. O alvo
    // padrao (AppData\Local) e gravavel, entao nao ha por que pedir elevacao — era
    // isso que travava o start automatico em maquinas de operador comuns.
    const instalavelSemAdmin = canWriteToDir(dirPath);
    if (privilegeStatus.requiresAdminForLocalInstall && !privilegeStatus.isElevated && !instalavelSemAdmin) {
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

      // Mata a arvore + espera a porta liberar de verdade; o sleep cego de
      // 500ms era insuficiente para o Windows soltar os file locks do sqlite.
      const { portFree } = await stopMyZapAndFreePort({ timeoutMs: 15000 });
      if (!portFree) {
        warn('Reinstalacao: porta 5555 continua em uso apos kill', {
          metadata: { area: 'clonarRepositorio', dirPath },
        });
      }

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

    // Pina o download no commit SHA atual da main: alem de eliminar corrida
    // com push durante o download, registra a versao instalada para o fluxo
    // de atualizacao sem Git (updateChecker). Sem rede p/ API, baixa a main.
    const shaParaInstalar = String(options.sha || '').trim() || await fetchRemoteMainSha() || '';

    try {
      await downloadRepositoryArchive(dirPath, {
        onProgress: reportProgress,
        sha: shaParaInstalar,
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

    if (shaParaInstalar) {
      setInstalledSha(shaParaInstalar);
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
// Reusado pelo updateMyZap para rodar `pnpm install` no staging com o mesmo
// watchdog/heartbeat deste fluxo.
module.exports.rodarComando = rodarComando;
