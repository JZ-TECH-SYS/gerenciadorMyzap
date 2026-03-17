const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { error: logError, info, warn } = require('./myzapLogger');
const {
  isPortInUse,
  isLocalHttpServiceReachable,
  getPnpmCommand,
  getGitCommand,
} = require('./processUtils');
const { transition } = require('./stateMachine');

function getErrorMessage(error) {
  return error && error.message ? error.message : String(error);
}

/** Referencia ao child process ativo do MyZap (pnpm start) */
let myzapChildProcess = null;

/**
 * Mata o child process rastreado do MyZap, se existir.
 */
function killMyZapProcess() {
  if (!myzapChildProcess) {
    info('killMyZapProcess: nenhum child process rastreado para matar', {
      metadata: { area: 'iniciarMyZap' },
    });
    return;
  }

  try {
    const { pid } = myzapChildProcess;
    myzapChildProcess.kill('SIGTERM');
    info('killMyZapProcess: SIGTERM enviado ao child process do MyZap', {
      metadata: { area: 'iniciarMyZap', pid },
    });
  } catch (err) {
    warn('killMyZapProcess: falha ao matar child process', {
      metadata: { area: 'iniciarMyZap', error: getErrorMessage(err) },
    });
  } finally {
    myzapChildProcess = null;
  }
}

function executarComando(executor, args, cwd) {
  return new Promise((resolve, reject) => {
    const runner = (typeof executor === 'string')
      ? {
        command: executor,
        prefixArgs: [],
        shell: false,
        env: process.env,
      }
      : {
        prefixArgs: [],
        shell: false,
        env: process.env,
        ...executor,
      };
    const child = spawn(runner.command, [...runner.prefixArgs, ...args], {
      cwd,
      shell: runner.shell,
      env: runner.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const commandLabel = runner.source || runner.command;

    let stderr = '';

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `Comando "${commandLabel}" finalizou com codigo ${code}.`));
    });
  });
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function aguardarPorta(porta, timeoutMs = 20000, intervalMs = 500) {
  const inicio = Date.now();
  async function verificarNovamente() {
    const [portaAtiva, httpAtivo] = await Promise.all([
      isPortInUse(porta),
      isLocalHttpServiceReachable({ timeoutMs: Math.min(intervalMs, 3000) }),
    ]);

    if (portaAtiva || httpAtivo) {
      return true;
    }

    if (Date.now() - inicio >= timeoutMs) {
      return false;
    }

    await wait(intervalMs);
    return verificarNovamente();
  }

  return verificarNovamente();
}

async function iniciarMyZap(dirPath, options = {}) {
  try {
    const reportProgress = (typeof options.onProgress === 'function')
      ? options.onProgress
      : () => {};
    const porta = 5555;

    transition('starting_service', { message: 'Validando se o MyZap ja esta em execucao...', dirPath });

    reportProgress('Validando se o MyZap ja esta em execucao...', 'check_runtime', {
      percent: 86,
      dirPath,
      porta,
    });
    const [portaAtiva, httpAtivo] = await Promise.all([
      isPortInUse(porta),
      isLocalHttpServiceReachable({ timeoutMs: 3000 }),
    ]);
    const estaRodando = portaAtiva || httpAtivo;

    if (estaRodando) {
      transition('running', {
        message: 'MyZap ja estava em execucao local.',
        dirPath,
        porta,
        detectadoVia: portaAtiva ? 'porta' : 'http',
      });
      reportProgress('MyZap ja estava em execucao local.', 'already_running', {
        percent: 95,
        dirPath,
        porta,
        detectadoVia: portaAtiva ? 'porta' : 'http',
      });
      return {
        status: 'success',
        message: 'O MyZap ja esta em execucao.',
      };
    }

    const gitDir = path.join(dirPath, '.git');
    const gitRunner = await getGitCommand();
    if (fs.existsSync(gitDir) && gitRunner) {
      reportProgress('Atualizando codigo local do MyZap...', 'git_pull', {
        percent: 90,
        dirPath,
      });
      try {
        await executarComando(gitRunner, ['pull', 'origin', 'main'], dirPath);
      } catch (gitErr) {
        info('git pull falhou (nao-critico, continuando)', {
          metadata: { area: 'iniciarMyZap', error: getErrorMessage(gitErr) },
        });
      }
    } else if (fs.existsSync(gitDir)) {
      info('Diretorio .git encontrado, mas Git nao esta disponivel. Pulando git pull.', {
        metadata: { area: 'iniciarMyZap', dirPath },
      });
    } else {
      info('Diretorio .git nao encontrado, pulando git pull', {
        metadata: { area: 'iniciarMyZap', dirPath },
      });
    }

    const pnpmRunner = await getPnpmCommand();
    if (!pnpmRunner) {
      return {
        status: 'error',
        message: 'Nao foi possivel carregar o executor interno de inicializacao do MyZap.',
      };
    }

    reportProgress('Subindo processo local do MyZap...', 'run_start', {
      percent: 93,
      dirPath,
    });
    const child = spawn(pnpmRunner.command, [...pnpmRunner.prefixArgs, 'start'], {
      cwd: dirPath,
      shell: pnpmRunner.shell,
      env: pnpmRunner.env,
      detached: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Rastrear child process para kill posterior
    myzapChildProcess = child;

    child.stdout.on('data', (data) => {
      info('MyZap runtime stdout', {
        metadata: {
          area: 'iniciarMyZap',
          output: String(data).trim(),
        },
      });
    });
    let stderrOutput = '';

    child.stderr.on('data', (data) => {
      const text = String(data).trim();
      stderrOutput += (stderrOutput ? '\n' : '') + text;
      info('MyZap runtime stderr', {
        metadata: {
          area: 'iniciarMyZap',
          output: text,
        },
      });
    });

    let childError = null;

    child.on('error', (err) => {
      childError = err;
    });

    child.on('exit', (code, signal) => {
      if (typeof code === 'number' && code !== 0) {
        // Extrair primeira linha util do stderr (sem stack trace)
        const firstLine = stderrOutput
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l && !l.startsWith('at ') && !l.startsWith('node:'));
        const detail = firstLine || stderrOutput.slice(0, 200);
        const msg = detail
          ? `MyZap finalizou com codigo ${code}: ${detail}`
          : `MyZap finalizou com codigo ${code} (signal: ${signal || 'nenhum'})`;
        childError = new Error(msg);
      }
      // Limpar referencia do child ao sair
      if (myzapChildProcess === child) {
        myzapChildProcess = null;
      }
    });

    reportProgress('Aguardando MyZap abrir a porta local...', 'wait_port', {
      percent: 96,
      dirPath,
      porta,
    });
    const abriuPorta = await aguardarPorta(porta, 180000, 1500);

    if (!abriuPorta) {
      transition('error', {
        message: childError
          ? `Falha ao iniciar: ${childError.message}`
          : `MyZap nao abriu a porta ${porta} dentro do tempo esperado.`,
        phase: 'start_service',
      });
      return {
        status: 'error',
        message: childError
          ? `Falha ao iniciar: ${childError.message}`
          : `MyZap nao abriu a porta ${porta} dentro do tempo esperado.`,
      };
    }

    transition('running', { message: 'MyZap iniciado e porta confirmada.', dirPath, porta });

    info('MyZap iniciado e porta confirmada', {
      metadata: { porta, dirPath, runner: pnpmRunner.source || pnpmRunner.command },
    });
    reportProgress('MyZap iniciado e porta confirmada.', 'ready', {
      percent: 98,
      dirPath,
      porta,
    });

    return {
      status: 'success',
      message: 'MyZap iniciado com sucesso!',
    };
  } catch (err) {
    transition('error', { message: getErrorMessage(err), phase: 'start_service' });
    logError('Erro ao gerenciar inicio do MyZap', { metadata: { error: err } });
    return {
      status: 'error',
      message: `Erro: ${err.message}`,
    };
  }
}

module.exports = { iniciarMyZap, killMyZapProcess };
