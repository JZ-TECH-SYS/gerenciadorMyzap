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
const { getLocalSnapshotInfo, installFromLocalSnapshot, puppeteerCacheEnv } = require('./localSnapshot');

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

    // No Windows, rodar via shell OCULTO (cmd + CREATE_NO_WINDOW): o console
    // invisivel e HERDADO pelos subprocessos .cmd/.bat dos lifecycle scripts —
    // sem isso, cada script que chamava o shim node.cmd abria uma janela de
    // console na cara do cliente.
    const isWin = process.platform === 'win32';
    const quoteWin = (value) => (/\s/.test(String(value)) ? `"${value}"` : String(value));
    const command = isWin ? quoteWin(runner.command) : runner.command;
    const finalArgs = isWin
      ? [...runner.prefixArgs, ...args].map(quoteWin)
      : [...runner.prefixArgs, ...args];

    const proc = spawn(command, finalArgs, {
      shell: isWin ? true : runner.shell,
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

function limparDestinoSeguro(dirPath) {
  try {
    if (dirPath && fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
    return true;
  } catch (err) {
    logError('Erro ao limpar diretorio do MyZap', { metadata: { err, dirPath } });
    return false;
  }
}

function finalizarSnapshotOk(dirPath, resultado, reportProgress) {
  transition('installing_dependencies', {
    message: 'Dependencias ja incluidas no pacote embutido.',
    dirPath,
  });
  reportProgress('Dependencias ja incluidas no pacote embutido.', 'install_dependencies', {
    percent: 70,
    dirPath,
    viaSnapshot: true,
  });

  return { ok: true, sha: resultado.sha };
}

/**
 * Instalacao OFFLINE: extrai o snapshot embutido no instalador (codigo +
 * node_modules pronto + Chromium). Nao usa rede, pnpm nem scripts.
 * @returns {Promise<{ ok: boolean, sha: string|null, fatal?: object }>}
 */
async function tentarInstalarViaSnapshot(dirPath, snapshot, reportProgress, opts = {}) {
  try {
    if (opts.limparDestino && !limparDestinoSeguro(dirPath)) {
      return { ok: false, sha: null };
    }

    transition('cloning_repo', { message: 'Extraindo pacote embutido do MyZap...', dirPath });
    const resultado = await installFromLocalSnapshot(dirPath, {
      snapshot,
      onProgress: reportProgress,
    });

    return finalizarSnapshotOk(dirPath, resultado, reportProgress);
  } catch (err) {
    // Destino nao-vazio NAO e nosso: nada foi tocado e nada pode ser limpo
    // (pode ser uma pasta qualquer do usuario apontada por engano). Erro
    // fatal direto — o fluxo de rede falharia na MESMA validacao.
    if (err && err.code === 'EDESTINO_NAO_VAZIO') {
      transition('error', { message: err.message, dirPath });
      return {
        ok: false,
        sha: null,
        fatal: { status: 'error', message: err.message },
      };
    }

    warn('Instalacao via snapshot falhou; caindo para o fluxo de rede', {
      metadata: { area: 'clonarRepositorio', dirPath, error: getErrorMessage(err) },
    });
    // Extracao pode ter parado no meio: o destino (criado por nos) precisa
    // voltar a ficar limpo.
    limparDestinoSeguro(dirPath);
    return { ok: false, sha: null };
  }
}

/**
 * Instalacao ONLINE (fluxo historico): baixa o ZIP pinado por SHA e roda o
 * `pnpm install` com o runtime interno.
 * @returns {Promise<{ ok: boolean, sha: string|null, result?: object }>}
 */
async function instalarViaRede(dirPath, shaAlvo, reportProgress, cleanDestination = false) {
  const pnpmRunner = await getPnpmCommand();
  if (!pnpmRunner) {
    return {
      ok: false,
      sha: null,
      result: {
        status: 'error',
        message: 'Nao foi possivel carregar o instalador interno de dependencias do MyZap.',
      },
    };
  }

  info('Runner de dependencias selecionado para instalacao do MyZap', {
    metadata: {
      area: 'clonarRepositorio',
      runnerSource: pnpmRunner.source || pnpmRunner.command,
      dirPath,
    },
  });

  transition('cloning_repo', { message: 'Baixando pacote do MyZap...', dirPath });

  // Pina o download no commit SHA atual da main: alem de eliminar corrida
  // com push durante o download, registra a versao instalada para o fluxo
  // de atualizacao sem Git (updateChecker). Sem rede p/ API, baixa a main.
  const shaParaInstalar = shaAlvo || await fetchRemoteMainSha() || '';

  try {
    await downloadRepositoryArchive(dirPath, {
      onProgress: reportProgress,
      sha: shaParaInstalar,
      cleanDestination,
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
      ok: false,
      sha: null,
      result: {
        status: 'error',
        message: getErrorMessage(archiveErr) || 'Erro ao baixar o pacote do MyZap para instalacao local.',
      },
    };
  }

  transition('installing_dependencies', { message: 'Instalando dependencias do MyZap...', dirPath });

  reportProgress('Instalando dependencias do MyZap...', 'install_dependencies', {
    percent: 55,
    dirPath,
  });
  // Se um Chromium embutido ja existir no destino (resgate/reuso), o
  // postinstall do puppeteer reaproveita em vez de baixar de novo.
  const runnerComCache = {
    ...pnpmRunner,
    env: { ...pnpmRunner.env, ...puppeteerCacheEnv(dirPath) },
  };
  const instalouDeps = await rodarComando(
    runnerComCache,
    ['install'],
    { cwd: dirPath },
  );

  if (!instalouDeps) {
    return {
      ok: false,
      sha: null,
      result: {
        status: 'error',
        message: 'Pacote do MyZap baixado, mas houve erro ao instalar as dependencias locais.',
      },
    };
  }

  return { ok: true, sha: shaParaInstalar || null };
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

    // Fontes de instalacao decididas ANTES de qualquer acao destrutiva.
    // Quando o chamador pede um SHA especifico (update/reparo pinado), o
    // snapshot so e usado direto se for EXATAMENTE aquele SHA; senao vira
    // resgate caso a rede falhe.
    const shaAlvo = String(options.sha || '').trim();
    const snapshot = getLocalSnapshotInfo();
    const snapshotCombina = Boolean(snapshot)
      && (!shaAlvo || (snapshot.manifest.sha && snapshot.manifest.sha === shaAlvo));
    // Registrado ANTES de qualquer mexida: um destino que ja tinha conteudo
    // e que NAO passou pelo cleanup de reinstalacao jamais pode ser limpo
    // pelo resgate (pode ser uma pasta do usuario apontada por engano).
    const destinoEraVazio = !fs.existsSync(dirPath) || fs.readdirSync(dirPath).length === 0;

    // Reinstalacao sem NENHUMA fonte garantida (nem snapshot, nem pnpm
    // interno) nao pode apagar a instalacao atual — deixaria o cliente sem
    // nada. Aborta sem tocar em arquivo algum.
    if (reinstall && !snapshot && !(await getPnpmCommand())) {
      const message = 'Nao foi possivel carregar o instalador interno de dependencias do MyZap. Reinstalacao abortada sem alterar a instalacao atual.';
      transition('error', { message, dirPath });
      return { status: 'error', message };
    }

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

    // Fonte PREFERIDA (v3): Runtime Pack — artefato pronto do canal de
    // releases do myzap ou pack local (pendrive/Setup FULL/env). Instala,
    // configura dados e SOBE o servico sozinho, com validacao de saude.
    // skipStart e do fluxo legado de preservacao (dados dentro do motor) —
    // nele o pack nao entra para nao misturar os dois layouts numa rodada.
    let shaInstalado = null;
    let instalou = false;

    if (!options.skipStart) {
      try {
        // eslint-disable-next-line global-require
        const enginePack = require('./enginePack');
        const viaPack = await enginePack.installFromBestSourceUnlocked({
          onProgress: reportProgress,
          engineDir: dirPath,
        });
        if (viaPack && viaPack.status === 'success') {
          return {
            status: 'success',
            message: `MyZap instalado do Runtime Pack e iniciado (v${viaPack.version || '?'}).`,
          };
        }
        if (viaPack) {
          warn('Instalacao via Runtime Pack falhou; caindo para snapshot/rede', {
            metadata: { area: 'clonarRepositorio', dirPath, viaPack },
          });
        }
      } catch (packErr) {
        warn('Erro ao tentar Runtime Pack; caindo para snapshot/rede', {
          metadata: { area: 'clonarRepositorio', dirPath, error: getErrorMessage(packErr) },
        });
      }
    }

    // Snapshot embutido: instala OFFLINE (sem rede/pnpm/scripts) — heranca
    // v2, continua valendo enquanto houver Setup antigo em campo.
    if (snapshotCombina) {
      const viaSnapshot = await tentarInstalarViaSnapshot(dirPath, snapshot, reportProgress);
      if (viaSnapshot.ok) {
        instalou = true;
        shaInstalado = viaSnapshot.sha;
      } else if (viaSnapshot.fatal) {
        return viaSnapshot.fatal;
      }
    }

    if (!instalou) {
      // Na reinstalacao o destino e descartavel (dados ja resgatados): o
      // download pode limpar sobras em vez de abortar por pasta nao-vazia.
      const viaRede = await instalarViaRede(dirPath, shaAlvo, reportProgress, reinstall);
      if (viaRede.ok) {
        instalou = true;
        shaInstalado = viaRede.sha;
      } else if (snapshot && !snapshotCombina && (reinstall || destinoEraVazio)) {
        // Resgate offline: a rede falhou e existe um snapshot de OUTRA versao.
        // Um MyZap funcionando (atualizavel depois pelo botao) vale mais que
        // uma instalacao morta esperando a rede voltar.
        warn('Instalacao via rede falhou; usando snapshot embutido como resgate', {
          metadata: { area: 'clonarRepositorio', dirPath, shaAlvo },
        });
        const resgate = await tentarInstalarViaSnapshot(dirPath, snapshot, reportProgress, {
          limparDestino: true,
        });
        if (resgate.ok) {
          instalou = true;
          shaInstalado = resgate.sha;
        } else {
          return resgate.fatal || viaRede.result;
        }
      } else {
        return viaRede.result;
      }
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

    // skipStart: usado pela reinstalacao preservando dados — a sessao/banco
    // sao restaurados ANTES do start (senao o MyZap subiria sem a sessao).
    if (options.skipStart) {
      if (shaInstalado) {
        setInstalledSha(shaInstalado);
      }
      reportProgress('MyZap instalado (start adiado pelo chamador).', 'installed_no_start', {
        percent: 90,
        dirPath,
      });
      return {
        status: 'success',
        message: 'MyZap instalado e configurado (sem iniciar).',
      };
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

    if (shaInstalado) {
      setInstalledSha(shaInstalado);
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
