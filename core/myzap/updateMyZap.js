/**
 * Atualizacao/reinstalacao do MyZap local — modelo IN-PLACE.
 *
 * LICAO APRENDIDA (caso real): o pnpm cria links/junctions com CAMINHO
 * ABSOLUTO dentro do node_modules. Qualquer estrategia que renomeie/mova o
 * node_modules (o antigo "swap atomico" de diretorios) quebra os links por
 * dentro e deixa o MyZap morto com MODULE_NOT_FOUND. Por isso aqui:
 *
 *   - node_modules NUNCA muda de caminho;
 *   - so os arquivos de CODIGO sao trocados (backup leve -> copia do novo);
 *   - `pnpm install` roda DENTRO do diretorio final (links nascem certos);
 *   - servico e parado ANTES de qualquer mexida em arquivos;
 *   - qualquer falha => rollback: devolve o codigo antigo e religa.
 *
 * updateMyZapFromArchive(sha): atualizacao de versao (usada pelo updateChecker).
 * reinstallPreservingData(): reinstalacao LIMPA preservando dados (degrau 3 do
 * supervisor) — apaga tudo, instala do zero e devolve sessao/banco/.env.
 */

const fs = require('fs');
const path = require('path');
const Store = require('electron-store');
const { info, warn, error: logError } = require('./myzapLogger');
const { downloadRepositoryArchive } = require('./repositoryArchive');
const { iniciarMyZap, stopMyZapAndFreePort, isMyZapInstallComplete } = require('./iniciarMyZap');
const { syncMyZapConfigs } = require('./syncConfigs');
const { getPnpmCommand, isLocalHttpServiceReachable } = require('./processUtils');
const { transition } = require('./stateMachine');

const store = new Store();

/** Dados que NUNCA podem se perder numa troca de versao/reinstalacao. */
const PRESERVE_ENTRIES = [
    '.env',
    'database',
    'instances',
    'tokens',
    'userDataDir',
    '.wwebjs_cache'
];

/** Entradas que nao sao "codigo" e ficam paradas durante o update in-place. */
const KEEP_IN_PLACE = new Set([...PRESERVE_ENTRIES, 'node_modules']);

function getErrorMessage(err) {
    return err && err.message ? err.message : String(err);
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

function listCodeEntries(dirPath) {
    try {
        return fs.readdirSync(dirPath).filter((name) => !KEEP_IN_PLACE.has(name));
    } catch (_e) {
        return [];
    }
}

async function rodarPnpmInstall(dirPath, reportProgress, label) {
    const pnpmRunner = await getPnpmCommand();
    if (!pnpmRunner) {
        throw new Error('Nao foi possivel carregar o instalador interno de dependencias do MyZap.');
    }

    reportProgress(label, 'update_install_deps', { percent: 60, dirPath });

    // eslint-disable-next-line global-require
    const clonarRepositorio = require('./clonarRepositorio');
    const ok = await clonarRepositorio.rodarComando(pnpmRunner, ['install'], { cwd: dirPath });
    if (!ok) {
        throw new Error('Falha ao instalar dependencias do MyZap.');
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
 * Atualiza o codigo do MyZap para o commit `sha`, IN-PLACE.
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
    const codeBackup = `${dir}.code-backup`;

    // Sem instalacao previa valida => instalacao limpa pelo fluxo normal.
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

    // Sobras de tentativas anteriores
    rmrfSafe(staging);
    rmrfSafe(codeBackup);

    let filaEstavaAtiva = false;
    let codigoTrocado = false;
    const movedToBackup = [];

    try {
        transition('recovering', { message: 'Baixando nova versao do MyZap...', sha });
        reportProgress('Baixando nova versao do MyZap...', 'update_download', {
            percent: 30,
            dir,
            sha
        });

        // 1) download + extract no staging — servico CONTINUA no ar
        await downloadRepositoryArchive(staging, { onProgress: reportProgress, sha });
        if (!fs.existsSync(path.join(staging, 'index.js'))
            || !fs.existsSync(path.join(staging, 'package.json'))) {
            throw new Error('Pacote baixado esta incompleto (sem index.js/package.json).');
        }

        // 2) parar tudo ANTES de tocar em qualquer arquivo da instalacao
        reportProgress('Parando servico para aplicar a nova versao...', 'update_stop_service', {
            percent: 50,
            dir
        });
        filaEstavaAtiva = pararFilaSeAtiva();
        const { portFree } = await stopMyZapAndFreePort({ timeoutMs: 15000 });
        if (!portFree) {
            throw new Error('Porta 5555 nao liberou para aplicar a atualizacao.');
        }

        // 3) backup leve do CODIGO atual (dados e node_modules ficam no lugar)
        fs.mkdirSync(codeBackup, { recursive: true });
        for (const entry of listCodeEntries(dir)) {
            fs.renameSync(path.join(dir, entry), path.join(codeBackup, entry));
            movedToBackup.push(entry);
        }
        codigoTrocado = true;

        // 4) copia o codigo novo para DENTRO do diretorio (caminho preservado)
        reportProgress('Aplicando nova versao...', 'update_swap', { percent: 55, dir });
        for (const entry of fs.readdirSync(staging)) {
            if (entry === 'node_modules') continue;
            fs.cpSync(path.join(staging, entry), path.join(dir, entry), {
                recursive: true,
                force: true
            });
        }

        // 5) dependencias IN-PLACE: pnpm ajusta o node_modules existente no
        // proprio caminho final — links/junctions continuam validos.
        await rodarPnpmInstall(dir, reportProgress, 'Atualizando dependencias do MyZap...');
        if (!isMyZapInstallComplete(dir)) {
            throw new Error('Dependencias nao ficaram completas apos o install.');
        }

        // 6) garante .env/banco e sobe
        syncMyZapConfigs(dir, {
            envContent: String(store.get('myzap_envContent') || ''),
            overwriteDb: false
        });

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
        rmrfSafe(codeBackup);
        rmrfSafe(staging);
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
            metadata: { area: 'updateMyZap', dir, sha, codigoTrocado, error: getErrorMessage(err) }
        });

        // ROLLBACK: devolve o codigo antigo por cima; dados/node_modules nunca
        // sairam do lugar, entao a instalacao volta exatamente ao que era.
        try {
            if (codigoTrocado) {
                await stopMyZapAndFreePort({ timeoutMs: 10000 });
                for (const entry of movedToBackup) {
                    const original = path.join(codeBackup, entry);
                    const destino = path.join(dir, entry);
                    if (!fs.existsSync(original)) continue;
                    rmrfSafe(destino);
                    fs.renameSync(original, destino);
                }
                // lockfile antigo de volta: install rapido garante consistencia
                try {
                    await rodarPnpmInstall(dir, reportProgress, 'Restaurando dependencias da versao anterior...');
                } catch (_e) { /* melhor esforco — node_modules antigo segue no lugar */ }

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
 * Reinstalacao LIMPA preservando dados — degrau 3 do supervisor e reparo
 * manual. Poe sessao/banco/.env num diretorio de resgate, reinstala do zero
 * (pnpm install roda no caminho FINAL: links certos) e devolve os dados
 * ANTES de subir o servico.
 */
async function reinstallPreservingData(options = {}) {
    const reportProgress = (typeof options.onProgress === 'function')
        ? options.onProgress
        : () => {};

    // eslint-disable-next-line global-require
    const { resolveMyZapDirectory } = require('./autoConfig');
    // eslint-disable-next-line global-require
    const { getInstalledSha, setInstalledSha } = require('./updateChecker');
    // eslint-disable-next-line global-require
    const clonarRepositorio = require('./clonarRepositorio');

    const dir = resolveMyZapDirectory().dir;
    const rescue = `${dir}.rescue-data`;
    const sha = getInstalledSha() || '';
    const envContent = String(store.get('myzap_envContent') || '');

    let filaEstavaAtiva = false;

    try {
        transition('recovering', { message: 'Reinstalando o MyZap preservando a sessao...' });
        reportProgress('Reinstalando o MyZap preservando a sessao...', 'reinstall_start', {
            percent: 10,
            dir
        });

        filaEstavaAtiva = pararFilaSeAtiva();
        await stopMyZapAndFreePort({ timeoutMs: 15000 });

        // 1) resgatar dados (sobras de tentativas anteriores tambem contam:
        // se ja existe um rescue de uma rodada que morreu no meio, PRESERVA)
        if (!fs.existsSync(rescue)) {
            fs.mkdirSync(rescue, { recursive: true });
        }
        for (const entry of PRESERVE_ENTRIES) {
            const origem = path.join(dir, entry);
            const destino = path.join(rescue, entry);
            if (fs.existsSync(origem) && !fs.existsSync(destino)) {
                try {
                    fs.renameSync(origem, destino);
                } catch (err) {
                    warn('reinstallPreservingData: falha ao resgatar item, copiando', {
                        metadata: { area: 'updateMyZap', entry, error: getErrorMessage(err) }
                    });
                    try {
                        fs.cpSync(origem, destino, { recursive: true, force: true });
                    } catch (_e) { /* melhor esforco */ }
                }
            }
        }

        // 2) instalacao limpa SEM start (dados voltam antes de subir)
        const result = await clonarRepositorio(dir, envContent, true, {
            onProgress: reportProgress,
            sha,
            skipStart: true
        });
        if (result?.status !== 'success') {
            return result || { status: 'error', message: 'Falha na reinstalacao do MyZap.' };
        }

        // 3) devolver os dados resgatados ANTES do start (sessao reconecta)
        for (const entry of PRESERVE_ENTRIES) {
            const origem = path.join(rescue, entry);
            const destino = path.join(dir, entry);
            if (!fs.existsSync(origem)) continue;
            rmrfSafe(destino);
            fs.renameSync(origem, destino);
        }
        rmrfSafe(rescue);

        // 4) subir e confirmar
        reportProgress('Iniciando MyZap reinstalado...', 'reinstall_start_service', {
            percent: 90,
            dir
        });
        const startResult = await iniciarMyZap(dir, { onProgress: reportProgress });
        if (startResult?.status !== 'success') {
            return startResult;
        }

        if (sha) {
            setInstalledSha(sha);
        }

        info('reinstallPreservingData: reinstalacao concluida com dados preservados', {
            metadata: { area: 'updateMyZap', dir }
        });
        return { status: 'success', message: 'MyZap reinstalado com a sessao preservada.' };
    } catch (err) {
        logError('reinstallPreservingData: falha na reinstalacao', {
            metadata: { area: 'updateMyZap', dir, error: getErrorMessage(err) }
        });
        return {
            status: 'error',
            message: `Falha na reinstalacao do MyZap: ${getErrorMessage(err)}`
        };
    } finally {
        religarFila(filaEstavaAtiva);
    }
}

module.exports = {
    PRESERVE_ENTRIES,
    updateMyZapFromArchive,
    reinstallPreservingData
};
