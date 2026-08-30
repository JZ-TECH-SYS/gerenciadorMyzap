const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { error: logError, info, warn } = require('./myzapLogger');
const {
  isPortInUse,
  isLocalHttpServiceReachable,
  killProcessTree,
  killProcessesOnPort,
  waitForPortFree,
  envWithNodeShim,
} = require('./processUtils');
const { transition } = require('./stateMachine');
const { puppeteerCacheEnv } = require('./localSnapshot');
const { isPackEngine, getEngineNodeExe, resolveDataDir } = require('./enginePaths');

/**
 * Instalacao apta a rodar? (index.js + dependencias instaladas)
 * Usado antes do start (erro claro em vez de stack de MODULE_NOT_FOUND) e
 * pelo supervisor para pular direto a reinstalacao quando faltam pecas.
 */
function isMyZapInstallComplete(dirPath) {
  try {
    return Boolean(dirPath)
      && fs.existsSync(path.join(dirPath, 'index.js'))
      && fs.existsSync(path.join(dirPath, 'node_modules', 'express'));
  } catch (_e) {
    return false;
  }
}

function getErrorMessage(error) {
  return error && error.message ? error.message : String(error);
}

/** Referencia ao child process ativo do MyZap (pnpm start) */
let myzapChildProcess = null;

/**
 * Mata a ARVORE do child process rastreado do MyZap, se existir.
 * Matar so o pai (pnpm) deixava o `node index.js` filho vivo segurando a
 * porta 5555 no Windows — causa raiz do "MyZap travado ao reiniciar".
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
    const killed = killProcessTree(pid);
    info('killMyZapProcess: arvore de processos do MyZap finalizada', {
      metadata: { area: 'iniciarMyZap', pid, killed },
    });
  } catch (err) {
    warn('killMyZapProcess: falha ao matar child process', {
      metadata: { area: 'iniciarMyZap', error: getErrorMessage(err) },
    });
  } finally {
    myzapChildProcess = null;
  }
}

/**
 * Parada completa do servico: mata a arvore rastreada, varre a porta 5555
 * (pega processos que escaparam do rastreio, ex.: instancia antiga) e espera
 * a porta ficar REALMENTE livre antes de devolver o controle.
 *
 * @returns {Promise<{ portFree: boolean }>}
 */
async function stopMyZapAndFreePort(options = {}) {
  const porta = Number.isFinite(options.port) ? options.port : 5555;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000;

  killMyZapProcess();

  const portKill = killProcessesOnPort(porta);
  if (portKill.killed.length > 0 || portKill.failed.length > 0) {
    info('stopMyZapAndFreePort: varredura da porta concluida', {
      metadata: { area: 'iniciarMyZap', porta, ...portKill },
    });
  }

  const portFree = await waitForPortFree(porta, { timeoutMs });
  if (!portFree) {
    warn('stopMyZapAndFreePort: porta continua em uso apos kill', {
      metadata: { area: 'iniciarMyZap', porta, timeoutMs },
    });
  }

  return { portFree };
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

    if (!isMyZapInstallComplete(dirPath)) {
      transition('error', {
        message: 'Instalacao do MyZap incompleta (codigo ou dependencias ausentes).',
        phase: 'start_service',
      });
      return {
        status: 'error',
        incompleteInstall: true,
        message: 'Instalacao do MyZap incompleta (codigo ou dependencias ausentes). Use "Reparar MyZap agora" para reinstalar preservando a sessao.',
      };
    }

    reportProgress('Subindo processo local do MyZap...', 'run_start', {
      percent: 93,
      dirPath,
    });
    // Runtime (v3): pack traz o PROPRIO node.exe (ABI do sqlite3 casado no
    // build — o Electron do app pode subir de versao sem invalidar o motor).
    // Sem node embutido (instalacao legada), cai no Electron-as-Node de sempre.
    const nodeExe = getEngineNodeExe(dirPath);
    const packMode = isPackEngine(dirPath);
    // CWD = diretorio de DADOS. No pack, e o myzap-data ao lado (o .env, o
    // sqlite e a sessao ficam FORA do codigo — update nunca encosta neles);
    // no legado, resolve para o proprio dirPath (comportamento identico).
    const dataDir = resolveDataDir(dirPath);
    if (packMode) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const spawnEnv = {
      // shim de `node` continua no PATH apenas para subprocessos eventuais.
      // Chromium embutido (snapshot/pack) fica visivel ao puppeteer —
      // maquina sem Chrome instalado tambem consegue abrir o WhatsApp.
      ...envWithNodeShim(process.env),
      ...puppeteerCacheEnv(dirPath),
    };
    if (!nodeExe) {
      spawnEnv.ELECTRON_RUN_AS_NODE = '1';
    }

    const child = spawn(nodeExe || process.execPath, [path.join(dirPath, 'index.js')], {
      cwd: dataDir,
      shell: false,
      env: spawnEnv,
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
    let resolveChildExit;
    const childExited = new Promise((resolve) => {
      resolveChildExit = resolve;
    });

    child.on('error', (err) => {
      childError = err;
      resolveChildExit();
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
      resolveChildExit();
    });

    reportProgress('Aguardando MyZap abrir a porta local...', 'wait_port', {
      percent: 96,
      dirPath,
      porta,
    });
    // Early-exit: se o processo morrer no meio, nao esperamos os 180s inteiros
    // pela porta — antes, um crash em 5s virava 3 minutos de tela travada.
    const resultadoEspera = await Promise.race([
      aguardarPorta(porta, 180000, 1500).then((ok) => (ok ? 'porta_aberta' : 'timeout')),
      childExited.then(() => 'processo_finalizou'),
    ]);

    let abriuPorta = resultadoEspera === 'porta_aberta';
    if (resultadoEspera === 'processo_finalizou') {
      // Ultima checagem: em cenarios raros o servico pode ter subido por outro
      // caminho (ex.: instancia previa) mesmo com o child finalizando.
      await wait(1000);
      const [portaAtivaPosExit, httpAtivoPosExit] = await Promise.all([
        isPortInUse(porta),
        isLocalHttpServiceReachable({ timeoutMs: 2000 }),
      ]);
      abriuPorta = portaAtivaPosExit || httpAtivoPosExit;
    }

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
      metadata: { porta, dirPath, runner: 'electron-as-node' },
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

module.exports = {
  iniciarMyZap,
  killMyZapProcess,
  stopMyZapAndFreePort,
  isMyZapInstallComplete,
};
