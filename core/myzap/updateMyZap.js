/**
 * Atualizacao/reinstalacao do MyZap local com troca atomica de diretorio.
 *
 * Fluxo (zero downtime ate o passo 3):
 *   1. baixa+extrai o ZIP (pinado num commit SHA) num STAGING irmao do destino
 *      (mesmo volume — os.tmpdir() poderia estar em outro disco e quebrar o
 *      rename atomico com EXDEV);
 *   2. roda pnpm install no staging se o lockfile mudou (servico segue no ar);
 *   3. para fila + mata arvore do servico + espera porta liberar de verdade;
 *   4. rename dir->backup, rename staging->dir;
 *   5. restaura dados preservados (sessao do WhatsApp reconecta sozinha no
 *      proximo boot: o MyZap le database/ + instances/ e chama
 *      startAllSessions());
 *   6. sobe o servico; sucesso => grava SHA e remove backup;
 *      falha => ROLLBACK: restaura backup e sobe a versao anterior.
 *
 * Tambem expoe reinstallPreservingData() — degrau 3 do supervisor.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Store = require('electron-store');
const { info, warn, error: logError } = require('./myzapLogger');
const { downloadRepositoryArchive } = require('./repositoryArchive');
const { iniciarMyZap, stopMyZapAndFreePort } = require('./iniciarMyZap');
const { syncMyZapConfigs } = require('./syncConfigs');
const { getPnpmCommand, isLocalHttpServiceReachable } = require('./processUtils');
const { transition } = require('./stateMachine');

const store = new Store();

/** Dados que NUNCA podem se perder na troca de versao. */
const PRESERVE_ENTRIES = [
    '.env',
    'database',
    'instances',
    'tokens',
    'userDataDir',
    '.wwebjs_cache'
];

function getErrorMessage(err) {
    return err && err.message ? err.message : String(err);
}

function hashFileSafe(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        const content = fs.readFileSync(filePath);
        return crypto.createHash('sha1').update(content).digest('hex');
    } catch (_e) {
        return null;
    }
}

function rmrfSafe(targetPath) {
    try {
        if (targetPath && fs.existsSync(targetPath)) {
            fs.rmSync(targetPath, { recursive: true, force: true });
        }
        return true;
    } catch (err) {
        warn('updateMyZap: falha ao remover diretorio temporario', {
            metadata: { area: 'updateMyZap', targetPath, error: getErrorMessage(err) }
        });
        return false;
    }
}

function restorePreservedEntries(backupDir, destDir) {
    const restored = [];
    for (const entry of PRESERVE_ENTRIES) {
        const source = path.join(backupDir, entry);
        const destination = path.join(destDir, entry);
        try {
            if (!fs.existsSync(source)) continue;
            fs.rmSync(destination, { recursive: true, force: true });
            fs.cpSync(source, destination, { recursive: true, force: true });
            restored.push(entry);
        } catch (err) {
            warn('updateMyZap: falha ao restaurar item preservado', {
                metadata: { area: 'updateMyZap', entry, error: getErrorMessage(err) }
            });
        }
    }
    return restored;
}

async function instalarDependenciasStaging(stagingDir, reportProgress) {
    const pnpmRunner = await getPnpmCommand();
    if (!pnpmRunner) {
        throw new Error('Nao foi possivel carregar o instalador interno de dependencias do MyZap.');
    }

    reportProgress('Instalando dependencias da nova versao do MyZap...', 'update_install_deps', {
        percent: 55,
        stagingDir
    });

    // eslint-disable-next-line global-require
    const clonarRepositorio = require('./clonarRepositorio');
    const ok = await clonarRepositorio.rodarComando(pnpmRunner, ['install'], { cwd: stagingDir });
    if (!ok) {
        throw new Error('Falha ao instalar dependencias da nova versao do MyZap.');
    }
}

async function aguardarServicoSaudavel(timeoutMs = 60000) {
    const inicio = Date.now();
    for (;;) {
        const ok = await isLocalHttpServiceReachable({ timeoutMs: 3000 });
        if (ok) return true;
        if (Date.now() - inicio >= timeoutMs) return false;
        await new Promise((resolve) => { setTimeout(resolve, 3000); });
    }
}

function pararFilaSeAtiva() {
    try {
        // require tardio para nao acoplar o boot dos modulos core/myzap a core/api
        // eslint-disable-next-line global-require
        const queue = require('../api/whatsappQueueWatcher');
        const estavaAtiva = Boolean(queue.getWhatsappQueueWatcherStatus()?.ativo);
        if (estavaAtiva) {
            queue.stopWhatsappQueueWatcher();
        }
        return estavaAtiva;
    } catch (_e) {
        return false;
    }
}

function religarFila(estavaAtiva) {
    if (!estavaAtiva) return;
    try {
        // eslint-disable-next-line global-require
        const queue = require('../api/whatsappQueueWatcher');
        Promise.resolve(queue.startWhatsappQueueWatcher()).catch(() => {});
    } catch (_e) { /* melhor esforco */ }
}

/**
 * Troca a instalacao do MyZap pela versao do commit `sha`, preservando dados.
 * Deve rodar DENTRO do opLock (updateChecker/supervisor cuidam disso).
 */
async function updateMyZapFromArchive(sha, options = {}) {
    const reportProgress = (typeof options.onProgress === 'function')
        ? options.onProgress
        : () => {};

    // eslint-disable-next-line global-require
    const { resolveMyZapDirectory, isValidInstalledMyZapDirectory } = require('./autoConfig');
    // eslint-disable-next-line global-require
    const { setInstalledSha } = require('./updateChecker');

    const resolution = resolveMyZapDirectory();
    const dir = resolution.dir;
    const staging = `${dir}.staging`;
    const backup = `${dir}.old`;

    // Sem instalacao previa, e uma instalacao limpa: delega ao fluxo normal.
    if (!isValidInstalledMyZapDirectory(dir)) {
        info('updateMyZap: sem instalacao previa valida, executando instalacao limpa', {
            metadata: { area: 'updateMyZap', dir, sha }
        });
        // eslint-disable-next-line global-require
        const clonarRepositorio = require('./clonarRepositorio');
        const envContent = String(store.get('myzap_envContent') || '');
        const result = await clonarRepositorio(dir, envContent, true, {
            onProgress: reportProgress,
            sha
        });
        if (result?.status === 'success' && sha) {
            setInstalledSha(sha);
        }
        return result;
    }

    // Limpa sobras de tentativas anteriores
    rmrfSafe(staging);
    rmrfSafe(backup);

    let filaEstavaAtiva = false;
    let swapped = false;

    try {
        transition('recovering', { message: 'Baixando nova versao do MyZap...', sha });
        reportProgress('Baixando nova versao do MyZap...', 'update_download', {
            percent: 30,
            dir,
            sha
        });

        // 1) download + extract no staging — servico CONTINUA no ar
        await downloadRepositoryArchive(staging, { onProgress: reportProgress, sha });

        // 2) deps: so roda pnpm install se o lockfile mudou (ou node_modules ausente)
        const lockAtual = hashFileSafe(path.join(dir, 'pnpm-lock.yaml'));
        const lockNovo = hashFileSafe(path.join(staging, 'pnpm-lock.yaml'));
        const nodeModulesNovoExiste = fs.existsSync(path.join(staging, 'node_modules'));
        const nodeModulesAtual = path.join(dir, 'node_modules');

        if (lockAtual && lockNovo && lockAtual === lockNovo && fs.existsSync(nodeModulesAtual)) {
            reportProgress('Dependencias inalteradas, reaproveitando node_modules...', 'update_reuse_deps', {
                percent: 55,
                dir
            });
            // mover node_modules atual para o staging e mais rapido que reinstalar
            try {
                fs.renameSync(nodeModulesAtual, path.join(staging, 'node_modules'));
            } catch (_e) {
                await instalarDependenciasStaging(staging, reportProgress);
            }
        } else if (!nodeModulesNovoExiste) {
            await instalarDependenciasStaging(staging, reportProgress);
        }

        // 3) parar tudo e liberar a porta DE VERDADE
        reportProgress('Parando servico para aplicar a nova versao...', 'update_stop_service', {
            percent: 70,
            dir
        });
        filaEstavaAtiva = pararFilaSeAtiva();
        const { portFree } = await stopMyZapAndFreePort({ timeoutMs: 15000 });
        if (!portFree) {
            throw new Error('Porta 5555 nao liberou para aplicar a atualizacao.');
        }

        // 4) swap atomico (janela critica)
        reportProgress('Aplicando nova versao...', 'update_swap', { percent: 78, dir });
        fs.renameSync(dir, backup);
        try {
            fs.renameSync(staging, dir);
        } catch (swapErr) {
            // staging nao virou dir: devolve o backup imediatamente
            fs.renameSync(backup, dir);
            throw swapErr;
        }
        swapped = true;

        // 5) restaurar dados preservados por cima do que veio no ZIP
        const restored = restorePreservedEntries(backup, dir);
        info('updateMyZap: dados preservados restaurados', {
            metadata: { area: 'updateMyZap', restored }
        });

        // garante .env/banco caso o backup nao tivesse (instalacao corrompida)
        syncMyZapConfigs(dir, {
            envContent: String(store.get('myzap_envContent') || ''),
            overwriteDb: false
        });

        // 6) subir e confirmar
        reportProgress('Iniciando nova versao do MyZap...', 'update_start', { percent: 88, dir });
        const startResult = await iniciarMyZap(dir, { onProgress: reportProgress });
        const saudavel = startResult?.status === 'success' && await aguardarServicoSaudavel(60000);

        if (!saudavel) {
            throw new Error(startResult?.status === 'success'
                ? 'Nova versao subiu mas nao respondeu no tempo esperado.'
                : `Nova versao nao iniciou: ${startResult?.message || 'erro desconhecido'}`);
        }

        if (sha) {
            setInstalledSha(sha);
        }
        rmrfSafe(backup);
        religarFila(filaEstavaAtiva);

        info('updateMyZap: atualizacao concluida com sucesso', {
            metadata: { area: 'updateMyZap', dir, sha }
        });
        reportProgress('MyZap atualizado com sucesso.', 'update_done', { percent: 100, dir, sha });

        return {
            status: 'success',
            message: 'MyZap atualizado com sucesso.',
            sha: sha || null
        };
    } catch (err) {
        logError('updateMyZap: falha na atualizacao, executando rollback', {
            metadata: { area: 'updateMyZap', dir, sha, swapped, error: getErrorMessage(err) }
        });

        // ROLLBACK: nunca deixar o cliente sem diretorio funcional
        try {
            if (swapped && fs.existsSync(backup)) {
                await stopMyZapAndFreePort({ timeoutMs: 10000 });
                rmrfSafe(dir);
                fs.renameSync(backup, dir);
                const rollbackStart = await iniciarMyZap(dir, {});
                warn('updateMyZap: rollback aplicado, versao anterior restaurada', {
                    metadata: {
                        area: 'updateMyZap',
                        rollbackStart: rollbackStart?.status || 'error'
                    }
                });
            }
        } catch (rollbackErr) {
            logError('updateMyZap: rollback tambem falhou', {
                metadata: { area: 'updateMyZap', error: getErrorMessage(rollbackErr) }
            });
        } finally {
            rmrfSafe(staging);
            religarFila(filaEstavaAtiva);
        }

        return {
            status: 'error',
            message: `Falha ao atualizar MyZap: ${getErrorMessage(err)}. A versao anterior foi mantida.`
        };
    }
}

/**
 * Reinstala a versao ATUAL preservando dados — degrau 3 do supervisor.
 * Usa o SHA instalado (ou main, se desconhecido).
 */
async function reinstallPreservingData(options = {}) {
    // eslint-disable-next-line global-require
    const { getInstalledSha } = require('./updateChecker');
    const sha = getInstalledSha() || '';
    return updateMyZapFromArchive(sha, options);
}

module.exports = {
    PRESERVE_ENTRIES,
    updateMyZapFromArchive,
    reinstallPreservingData
};
