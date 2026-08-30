/**
 * Runtime Pack do MyZap — instalação e atualização do motor como ARTEFATO
 * PRONTO, com troca atômica e rollback real.
 *
 * Modelo (v3): o CI do repo myzap publica, por TAG, um zip pronto para rodar
 * (código dieta + node_modules + Chromium + Node embutido + semente do banco
 * gerada pelas migrations) e um manifest.json. Aqui a gente:
 *
 *   1. compara a versão do manifest do CANAL (ou de um pack LOCAL ao lado do
 *      instalador / apontado por env) com a instalada;
 *   2. baixa com retry e confere o sha256;
 *   3. extrai em <motor>.staging COM O SERVIÇO AINDA NO AR;
 *   4. para o serviço, faz rename <motor>→<motor>.old e .staging→<motor>;
 *   5. garante os DADOS em myzap-data\ (migrando o layout legado uma única
 *      vez: .env, database/, instances/ saem de dentro do motor);
 *   6. sobe e confirma a saúde; falhou => rename de volta (rollback) e sobe a
 *      versão anterior. Dados nunca são tocados pela troca.
 *
 * Isso substitui o update in-place por SHA da main (updateChecker/updateMyZap)
 * — que rodava pnpm no cliente e quebrou clientes na v2.0.x. O caminho legado
 * continua existindo APENAS como fallback enquanto o canal não tem release.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const extractZip = require('extract-zip');
const Store = require('electron-store');
const { info, warn, error: logError } = require('./myzapLogger');
const { withLifecycleLock } = require('./opLock');
const opLock = require('./opLock');
const { baixarArquivoComRetry } = require('./repositoryArchive');
const {
    DATA_ENTRIES,
    readEngineManifest,
    getDataDirFor,
    getPacksCacheDirFor
} = require('./enginePaths');
const { transition } = require('./stateMachine');

const store = new Store();

const PLATFORM_TAG = `${process.platform}-${process.arch}`;
const PACK_BASENAME = `myzap-pack-${PLATFORM_TAG}`;
const CHANNEL_LATEST_MANIFEST_URL = `https://github.com/JZ-TECH-SYS/myzap/releases/latest/download/${PACK_BASENAME}.manifest.json`;
const channelZipUrlFor = (version) => `https://github.com/JZ-TECH-SYS/myzap/releases/download/v${version}/${PACK_BASENAME}.zip`;
const FETCH_TIMEOUT_MS = 15000;
const HEALTH_CONFIRM_MS = 90 * 1000;

function getErrorMessage(err) {
    return err && err.message ? err.message : String(err);
}

/**
 * Diretório do MOTOR para operações de pack. Confia no caminho salvo mesmo
 * que a pasta AINDA NÃO exista — é instalação nova. (O resolveMyZapDirectory
 * do autoConfig rejeita pasta sem package.json e cai no default: regra certa
 * para achar uma instalação LEGADA existente, errada para instalar — o E2E
 * pegou o pack indo parar no LOCALAPPDATA real em vez do destino pedido.)
 */
function getEngineDir(explicitDir) {
    if (explicitDir) return path.resolve(String(explicitDir));
    const stored = String(store.get('myzap_diretorio') || '').trim();
    if (stored) return path.resolve(stored);
    // eslint-disable-next-line global-require
    const { getDefaultMyZapDirectory } = require('./autoConfig');
    return getDefaultMyZapDirectory();
}

function rmrfSafe(target) {
    try {
        if (target && fs.existsSync(target)) {
            fs.rmSync(target, { recursive: true, force: true });
        }
        return true;
    } catch (err) {
        warn('enginePack: falha ao remover diretorio', {
            metadata: { area: 'enginePack', target, error: getErrorMessage(err) }
        });
        return false;
    }
}

function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex');
}

/** Compara versões "x.y.z" numericamente. > 0 se a > b. */
function compareVersions(a, b) {
    const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
        const diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

function isValidPackManifest(manifest) {
    return Boolean(
        manifest
        && manifest.name === 'myzap-pack'
        && manifest.version
        && (!manifest.platform || manifest.platform === PLATFORM_TAG)
    );
}

/* ── Fontes de pack ─────────────────────────────────────────── */

/**
 * Pack LOCAL: ao lado do executável (pendrive/Setup FULL), em resources/
 * (embutido no instalador) ou apontado por env (teste/desenvolvimento).
 * @returns {{ zipPath: string, manifest: object, source: string }|null}
 */
function findLocalPack() {
    const candidates = [];

    if (process.env.GERENCIADOR_PACK_ZIP) {
        candidates.push({ zip: process.env.GERENCIADOR_PACK_ZIP, source: 'env' });
    }
    try {
        candidates.push({
            zip: path.join(path.dirname(process.execPath), `${PACK_BASENAME}.zip`),
            source: 'ao_lado_do_exe'
        });
    } catch (_e) { /* melhor esforco */ }
    if (process.resourcesPath) {
        candidates.push({
            zip: path.join(process.resourcesPath, 'myzap-pack', `${PACK_BASENAME}.zip`),
            source: 'resources'
        });
    }

    for (const cand of candidates) {
        try {
            if (!cand.zip || !fs.existsSync(cand.zip)) continue;
            const manifestPath = cand.zip.replace(/\.zip$/i, '.manifest.json');
            let manifest = null;
            if (fs.existsSync(manifestPath)) {
                manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            }
            if (manifest && !isValidPackManifest(manifest)) continue;
            return { zipPath: cand.zip, manifest, source: cand.source };
        } catch (_e) { /* proximo candidato */ }
    }
    return null;
}

/** Manifest mais recente do canal de releases. null = canal indisponível/sem release. */
async function fetchChannelManifest() {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(CHANNEL_LATEST_MANIFEST_URL, {
            method: 'GET',
            headers: { 'User-Agent': 'gerenciador-myzap' },
            signal: ctrl.signal
        });
        if (!res.ok) {
            info('enginePack: canal sem release publicada (ou indisponivel)', {
                metadata: { area: 'enginePack', status: res.status }
            });
            return null;
        }
        const manifest = await res.json().catch(() => null);
        if (!isValidPackManifest(manifest)) {
            warn('enginePack: manifest do canal invalido/incompativel', {
                metadata: { area: 'enginePack', manifest }
            });
            return null;
        }
        return manifest;
    } catch (err) {
        info('enginePack: nao foi possivel consultar o canal (offline?)', {
            metadata: { area: 'enginePack', error: getErrorMessage(err) }
        });
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

/** Baixa o zip do canal para o cache local, valida sha256, devolve o caminho. */
async function downloadPackFromChannel(manifest, engineDir, reportProgress) {
    const cacheDir = getPacksCacheDirFor(engineDir);
    fs.mkdirSync(cacheDir, { recursive: true });
    const dest = path.join(cacheDir, `${PACK_BASENAME}-${manifest.version}.zip`);

    // Cache válido? Não baixa de novo (reparo offline usa exatamente isso).
    if (fs.existsSync(dest) && manifest.zipSha256 && sha256File(dest) === manifest.zipSha256) {
        info('enginePack: pack ja esta no cache local, download pulado', {
            metadata: { area: 'enginePack', version: manifest.version }
        });
        return dest;
    }

    reportProgress(`Baixando MyZap v${manifest.version}...`, 'pack_download', {
        percent: 25,
        version: manifest.version
    });
    const url = channelZipUrlFor(manifest.version);
    await baixarArquivoComRetry(url, dest);

    if (manifest.zipSha256) {
        const got = sha256File(dest);
        if (got !== manifest.zipSha256) {
            rmrfSafe(dest);
            throw new Error(`Pack baixado corrompido (sha256 divergente).`);
        }
    }

    // Mantém no cache só a versão atual e a anterior (reparo/rollback offline).
    try {
        const zips = fs.readdirSync(cacheDir)
            .filter((f) => f.startsWith(PACK_BASENAME) && f.endsWith('.zip'))
            .sort();
        while (zips.length > 2) {
            fs.rmSync(path.join(cacheDir, zips.shift()), { force: true });
        }
    } catch (_e) { /* melhor esforco */ }

    return dest;
}

/* ── Dados: migração e semente ──────────────────────────────── */

/**
 * Garante o diretório de DADOS pronto, migrando o layout legado uma única
 * vez (entradas saem de DENTRO do motor para myzap-data\ via rename).
 * Deve rodar com o serviço PARADO.
 */
function sleep(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Move com RETRY: no Windows, o Chrome/sqlite recém-mortos soltam os file
 * locks com 1-3s de atraso — um EPERM/EACCES imediato não é falha
 * definitiva. (Caso real: a migração de instances\ falhava ~1s depois do
 * kill e abortava a troca de motor inteira.)
 */
async function moverComRetry(origem, destino, tentativas = 4, esperaMs = 1500) {
    for (let i = 1; i <= tentativas; i += 1) {
        try {
            fs.renameSync(origem, destino);
            return true;
        } catch (err) {
            if (i === tentativas) {
                // último recurso: cópia + remoção da origem
                try {
                    fs.cpSync(origem, destino, { recursive: true, force: true });
                    fs.rmSync(origem, { recursive: true, force: true });
                    return !fs.existsSync(origem);
                } catch (_copyErr) {
                    return false;
                }
            }
            opLock.touch();
            await sleep(esperaMs);
        }
    }
    return false;
}

async function renameComRetry(origem, destino, tentativas = 4, esperaMs = 1500) {
    let lastErr = null;
    for (let i = 1; i <= tentativas; i += 1) {
        try {
            fs.renameSync(origem, destino);
            return;
        } catch (err) {
            lastErr = err;
            opLock.touch();
            await sleep(esperaMs);
        }
    }
    throw lastErr;
}

/**
 * Migra os dados do layout legado para o dataDir — TUDO OU NADA: se qualquer
 * entrada não conseguir sair do motor (lock persistente), TUDO que já foi
 * movido volta para o lugar, para o motor legado continuar INTEIRO e
 * religável. instances\ (a mais travável e a mais crítica — é a autenticação
 * do WhatsApp) vai primeiro.
 */
async function migrarDadosLegados(engineDir, dataDir) {
    const ordem = ['instances', ...DATA_ENTRIES.filter((e) => e !== 'instances')];
    const migradas = [];

    for (const entry of ordem) {
        const origem = path.join(engineDir, entry);
        const destino = path.join(dataDir, entry);
        if (!fs.existsSync(origem) || fs.existsSync(destino)) continue;

        const ok = await moverComRetry(origem, destino);
        if (ok) {
            migradas.push(entry);
            info('enginePack: dado migrado do layout legado', {
                metadata: { area: 'enginePack', entry }
            });
            continue;
        }

        warn('enginePack: migracao abortada — dado em uso; devolvendo o que ja foi movido', {
            metadata: { area: 'enginePack', entryTravada: entry, migradas }
        });
        for (const done of [...migradas].reverse()) {
            // eslint-disable-next-line no-await-in-loop
            const voltou = await moverComRetry(path.join(dataDir, done), path.join(engineDir, done));
            if (!voltou) {
                warn('enginePack: falha ao devolver dado na desmigracao', {
                    metadata: { area: 'enginePack', entry: done }
                });
            }
        }
        return { ok: false, entryTravada: entry };
    }

    return { ok: true, migradas };
}

async function ensureDataDirReady(engineDir, options = {}) {
    const dataDir = getDataDirFor(engineDir);
    fs.mkdirSync(dataDir, { recursive: true });

    // 1) migração do legado (dados dentro da pasta do motor) — atômica
    const mig = await migrarDadosLegados(engineDir, dataDir);
    if (!mig.ok) {
        if (options.strictMigration) {
            const err = new Error(`Dados do MyZap em uso (${mig.entryTravada}) — troca adiada; o motor atual continua no ar.`);
            err.code = 'EMIGRACAO_TRAVADA';
            throw err;
        }
        warn('enginePack: migracao de dados legados incompleta (seguindo sem strict)', {
            metadata: { area: 'enginePack', entryTravada: mig.entryTravada }
        });
    }

    // 2) .env: se ainda não existe, nasce do store/template
    const envPath = path.join(dataDir, '.env');
    if (!fs.existsSync(envPath)) {
        // eslint-disable-next-line global-require
        const { getOrCreateLocalToken, buildEnvContent } = require('./envTemplate');
        const envContent = String(store.get('myzap_envContent') || '').trim()
            || buildEnvContent({ token: getOrCreateLocalToken(store, dataDir) });
        fs.writeFileSync(envPath, envContent, 'utf8');
    }

    // 3) banco: semente vinda do PACK (gerada pelas migrations no CI); o
    // db.seed.sqlite embutido no app fica como último recurso (legado).
    const dbDir = path.join(dataDir, 'database');
    const dbFile = path.join(dbDir, 'db.sqlite');
    if (!fs.existsSync(dbFile)) {
        fs.mkdirSync(dbDir, { recursive: true });
        const packSeed = path.join(engineDir, 'seed', 'db.sqlite');
        const bundledSeed = path.join(__dirname, 'configs', 'db.seed.sqlite');
        const seed = fs.existsSync(packSeed) ? packSeed : bundledSeed;
        if (fs.existsSync(seed)) {
            fs.copyFileSync(seed, dbFile);
        }
    }

    // 4) cache do WhatsApp Web pré-populado no pack → primeiro boot offline
    const dataCache = path.join(dataDir, '.wwebjs_cache');
    const packCache = path.join(engineDir, '.wwebjs_cache');
    if (!fs.existsSync(dataCache) && fs.existsSync(packCache)) {
        try {
            fs.cpSync(packCache, dataCache, { recursive: true });
        } catch (_e) { /* melhor esforco */ }
    }

    if (!options.silent) {
        info('enginePack: diretorio de dados pronto', {
            metadata: { area: 'enginePack', dataDir }
        });
    }
    return dataDir;
}

/* ── Troca atômica ──────────────────────────────────────────── */

/**
 * Extrai o zip do pack. No Windows usa o tar.exe NATIVO (bsdtar): o pack é
 * gerado pelo mesmo bsdtar no CI e vem com entradas "./" que o extract-zip
 * (yauzl) rejeita como "Out of bound path". Fora do Windows, extract-zip.
 */
function extractPackZip(zipPath, destDir) {
    fs.mkdirSync(destDir, { recursive: true });
    if (process.platform !== 'win32') {
        return extractZip(zipPath, { dir: destDir });
    }
    const tarExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    return new Promise((resolve, reject) => {
        const proc = spawn(tarExe, ['-xf', zipPath, '-C', destDir], {
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'pipe']
        });
        let stderr = '';
        proc.stderr.on('data', (d) => { stderr += String(d); });
        proc.on('error', reject);
        proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`tar.exe saiu com codigo ${code}: ${stderr.slice(0, 300)}`));
        });
        // Extração longa é progresso real — não deixa o opLock apodrecer.
        const heartbeat = setInterval(() => opLock.touch(), 30000);
        proc.on('close', () => clearInterval(heartbeat));
    });
}

async function waitHealthy(timeoutMs) {
    // eslint-disable-next-line global-require
    const { isLocalHttpServiceReachable } = require('./processUtils');
    const inicio = Date.now();
    for (;;) {
        const ok = await isLocalHttpServiceReachable({ timeoutMs: 3000 });
        if (ok) return true;
        if (Date.now() - inicio >= timeoutMs) return false;
        await new Promise((resolve) => { setTimeout(resolve, 3000); });
        opLock.touch();
    }
}

/**
 * Aplica um pack (zip) como o novo motor. Roda DENTRO do opLock do chamador.
 * @returns {Promise<{status:string, message:string, version?:string, rolledBack?:boolean}>}
 */
async function applyPackZip(zipPath, options = {}) {
    const reportProgress = (typeof options.onProgress === 'function')
        ? options.onProgress
        : () => {};
    // eslint-disable-next-line global-require
    const { iniciarMyZap, stopMyZapAndFreePort, isMyZapInstallComplete } = require('./iniciarMyZap');

    const engineDir = getEngineDir(options.engineDir);
    const staging = `${engineDir}.staging`;
    const old = `${engineDir}.old`;

    rmrfSafe(staging);

    try {
        // 1) extrair e validar COM O SERVIÇO NO AR — falhou aqui, nada mudou
        transition('recovering', { message: 'Preparando nova versao do MyZap...' });
        reportProgress('Extraindo nova versao do MyZap...', 'pack_extract', { percent: 45 });
        await extractPackZip(zipPath, staging);
        opLock.touch();

        const stagedManifest = readEngineManifest(staging);
        if (!stagedManifest) {
            throw new Error('Pack extraido sem manifest.json valido.');
        }
        if (!fs.existsSync(path.join(staging, 'index.js'))
            || !fs.existsSync(path.join(staging, 'node_modules', 'express'))) {
            throw new Error('Pack extraido esta incompleto (sem index.js/node_modules).');
        }

        // 2) parar o serviço e liberar a porta
        reportProgress('Parando servico para aplicar a nova versao...', 'pack_stop', { percent: 60 });
        const { portFree } = await stopMyZapAndFreePort({ timeoutMs: 15000 });
        if (!portFree) {
            throw new Error('Porta 5555 nao liberou para aplicar a atualizacao.');
        }

        // 3) dados para fora do motor ANTES da troca (uma única vez, legado).
        // STRICT: se um dado estiver travado (lock residual do Chrome/sqlite
        // recém-mortos), a migração desfaz o que moveu e ABORTA a troca — o
        // motor legado fica inteiro e religável; tentamos no próximo ciclo.
        await ensureDataDirReady(engineDir, { silent: true, strictMigration: true });

        // 4) troca atômica por rename (mesmo volume): o motor antigo INTEIRO
        // vira .old — é o rollback pronto, sem cópia. Com retry: EPERM logo
        // após kill de processos é transitório no Windows.
        reportProgress('Aplicando nova versao...', 'pack_swap', { percent: 70 });
        rmrfSafe(old);
        const haviaMotorAntigo = fs.existsSync(engineDir);
        if (haviaMotorAntigo) {
            await renameComRetry(engineDir, old);
        }
        await renameComRetry(staging, engineDir);

        // semente/caches do pack novo para o data dir (se faltarem)
        await ensureDataDirReady(engineDir, { silent: true });

        // 5) subir e confirmar saúde
        reportProgress('Iniciando nova versao do MyZap...', 'pack_start', { percent: 85 });
        const startResult = await iniciarMyZap(engineDir, { onProgress: reportProgress });
        const saudavel = startResult?.status === 'success' && await waitHealthy(HEALTH_CONFIRM_MS);
        if (!saudavel) {
            throw new Error(startResult?.status === 'success'
                ? 'Nova versao subiu mas nao ficou saudavel no tempo esperado.'
                : `Nova versao nao iniciou: ${startResult?.message || 'erro desconhecido'}`);
        }

        // 6) sucesso: some com o .old
        rmrfSafe(old);
        store.set('myzap_installedPackVersion', stagedManifest.version);
        info('enginePack: motor atualizado com sucesso', {
            metadata: { area: 'enginePack', version: stagedManifest.version }
        });
        reportProgress(`MyZap v${stagedManifest.version} instalado.`, 'pack_done', { percent: 100 });
        return {
            status: 'success',
            message: `MyZap atualizado para v${stagedManifest.version}.`,
            version: stagedManifest.version
        };
    } catch (err) {
        logError('enginePack: falha ao aplicar pack', {
            metadata: { area: 'enginePack', zipPath, code: err?.code || null, error: getErrorMessage(err) }
        });

        // Migração travada = abortamos ANTES de tocar no motor: só religar o
        // legado (a desmigração já devolveu os dados) e tentar depois.
        const migracaoTravada = err?.code === 'EMIGRACAO_TRAVADA';

        // ROLLBACK: devolve o motor antigo pelo mesmo rename e religa.
        let rolledBack = false;
        try {
            // eslint-disable-next-line global-require
            const { iniciarMyZap, stopMyZapAndFreePort, isMyZapInstallComplete } = require('./iniciarMyZap');
            await stopMyZapAndFreePort({ timeoutMs: 10000 }).catch(() => {});
            if (fs.existsSync(old)) {
                const broken = `${engineDir}.broken`;
                rmrfSafe(broken);
                if (fs.existsSync(engineDir)) {
                    await renameComRetry(engineDir, broken);
                }
                await renameComRetry(old, engineDir);
                rolledBack = true;
                rmrfSafe(broken);
            }
            rmrfSafe(staging);
            if (isMyZapInstallComplete(engineDir)) {
                await iniciarMyZap(engineDir, {});
            }
        } catch (rollbackErr) {
            logError('enginePack: rollback com problemas (supervisor assume)', {
                metadata: { area: 'enginePack', error: getErrorMessage(rollbackErr) }
            });
        }

        return {
            status: 'error',
            rolledBack,
            adiadoPorDadosEmUso: migracaoTravada,
            message: migracaoTravada
                ? `${getErrorMessage(err)} Nova tentativa no proximo ciclo automatico.`
                : `Falha ao atualizar o MyZap: ${getErrorMessage(err)}.${rolledBack ? ' A versao anterior foi restaurada.' : ''}`
        };
    }
}

/* ── API de alto nível ──────────────────────────────────────── */

function getInstalledPackVersion() {
    const manifest = readEngineManifest(getEngineDir());
    return manifest?.version || null;
}

/**
 * Checa canal + fontes locais e atualiza se houver versão mais nova.
 * @param {{ force?: boolean, onProgress?: Function }} options
 *   force: aplica mesmo com a mesma versão (reparo) e exige alguma fonte.
 * @returns {Promise<object>} status: success|error|busy|up_to_date|no_source
 */
async function checkAndUpdatePack(options = {}) {
    const force = Boolean(options.force);

    return withLifecycleLock('pack-update', async () => {
        const engineDir = getEngineDir(options.engineDir);
        const installed = readEngineManifest(engineDir)?.version || null;

        const local = findLocalPack();
        const channel = await fetchChannelManifest();

        // escolhe a MELHOR fonte disponível (maior versão conhecida)
        let source = null;
        if (channel && local?.manifest) {
            source = compareVersions(local.manifest.version, channel.version) >= 0
                ? { kind: 'local', manifest: local.manifest, zipPath: local.zipPath }
                : { kind: 'channel', manifest: channel };
        } else if (channel) {
            source = { kind: 'channel', manifest: channel };
        } else if (local) {
            source = { kind: 'local', manifest: local.manifest, zipPath: local.zipPath };
        }

        if (!source) {
            return {
                status: 'no_source',
                installed,
                message: 'Nenhuma fonte de pack disponivel (canal sem release e sem pack local).'
            };
        }

        const targetVersion = source.manifest?.version || null;
        if (!force && installed && targetVersion
            && compareVersions(targetVersion, installed) <= 0) {
            return {
                status: 'up_to_date',
                installed,
                message: `MyZap ja esta na versao mais recente (v${installed}).`
            };
        }

        const reportProgress = (typeof options.onProgress === 'function')
            ? options.onProgress
            : () => {};

        let zipPath = source.zipPath;
        if (source.kind === 'channel') {
            zipPath = await downloadPackFromChannel(source.manifest, engineDir, reportProgress);
        }

        info('enginePack: aplicando pack', {
            metadata: {
                area: 'enginePack',
                installed,
                target: targetVersion,
                kind: source.kind
            }
        });
        return applyPackZip(zipPath, { onProgress: reportProgress, engineDir });
    });
}

/**
 * Reparo do MOTOR sem rede: reaplica o pack do cache local (ou uma fonte
 * local). Dados ficam intactos por construção. Usado pelo degrau 3 do
 * supervisor quando a instalação é em modo pack.
 * @returns {Promise<object|null>} null = não há pack para reaplicar (legado)
 */
async function repairEngineFromLocalSources(options = {}) {
    const engineDir = getEngineDir(options.engineDir);
    const cacheDir = getPacksCacheDirFor(engineDir);

    let zipPath = null;
    try {
        const zips = fs.existsSync(cacheDir)
            ? fs.readdirSync(cacheDir).filter((f) => f.endsWith('.zip')).sort()
            : [];
        if (zips.length > 0) {
            zipPath = path.join(cacheDir, zips[zips.length - 1]);
        }
    } catch (_e) { /* melhor esforco */ }

    if (!zipPath) {
        const local = findLocalPack();
        zipPath = local?.zipPath || null;
    }
    if (!zipPath) return null;

    info('enginePack: reparo do motor a partir de pack local', {
        metadata: { area: 'enginePack', zipPath }
    });
    return applyPackZip(zipPath, { engineDir });
}

/** Sobras de trocas interrompidas (.staging/.old/.broken) — limpar no boot. */
function cleanupLeftovers(options = {}) {
    try {
        const engineDir = getEngineDir(options.engineDir);
        for (const suffix of ['.staging', '.broken']) {
            rmrfSafe(`${engineDir}${suffix}`);
        }
        // .old só é lixo se o motor atual está íntegro
        // eslint-disable-next-line global-require
        const { isMyZapInstallComplete } = require('./iniciarMyZap');
        if (isMyZapInstallComplete(engineDir)) {
            rmrfSafe(`${engineDir}.old`);
        }
    } catch (_e) { /* melhor esforco */ }
}

/**
 * Instala/atualiza a partir da MELHOR fonte disponível SEM tomar o opLock —
 * para uso por chamadores que JÁ estão dentro do lock (ensure/clonar).
 * @returns {Promise<object|null>} null = nenhuma fonte de pack disponível
 */
async function installFromBestSourceUnlocked(options = {}) {
    const engineDir = getEngineDir(options.engineDir);
    const reportProgress = (typeof options.onProgress === 'function')
        ? options.onProgress
        : () => {};

    const local = findLocalPack();
    const channel = await fetchChannelManifest();

    let source = null;
    if (channel && local?.manifest) {
        source = compareVersions(local.manifest.version, channel.version) >= 0
            ? { kind: 'local', manifest: local.manifest, zipPath: local.zipPath }
            : { kind: 'channel', manifest: channel };
    } else if (channel) {
        source = { kind: 'channel', manifest: channel };
    } else if (local) {
        source = { kind: 'local', manifest: local.manifest, zipPath: local.zipPath };
    }
    if (!source) return null;

    let zipPath = source.zipPath;
    if (source.kind === 'channel') {
        zipPath = await downloadPackFromChannel(source.manifest, engineDir, reportProgress);
    }

    info('enginePack: instalando a partir da melhor fonte', {
        metadata: {
            area: 'enginePack',
            kind: source.kind,
            version: source.manifest?.version || null
        }
    });
    return applyPackZip(zipPath, { onProgress: reportProgress, engineDir });
}

module.exports = {
    PACK_BASENAME,
    compareVersions,
    findLocalPack,
    fetchChannelManifest,
    ensureDataDirReady,
    applyPackZip,
    checkAndUpdatePack,
    installFromBestSourceUnlocked,
    repairEngineFromLocalSources,
    getInstalledPackVersion,
    cleanupLeftovers
};
