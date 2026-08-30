/**
 * Snapshot OFFLINE do MyZap embutido no instalador (extraResources).
 *
 * O instalador carrega build/snapshot/myzap-snapshot.zip -> resources/
 * myzap-snapshot/ com o MyZap PRONTO: codigo + node_modules (hoisted, sem
 * junctions => movivel) + Chromium do puppeteer. Instalar = extrair o zip.
 * Nada de rede, pnpm, lifecycle scripts ou compilacao no PC do cliente — as
 * causas classicas do "em uns computadores instala, em outros nao".
 *
 * O snapshot e a fonte PREFERIDA de instalacao/reinstalacao (inclusive o
 * degrau 3 do supervisor, que passa a reparar offline). A atualizacao por
 * SHA (updateChecker/updateMyZap) segue via rede, como sempre.
 */

const fs = require('fs');
const path = require('path');
const extractZip = require('extract-zip');
const { info, warn } = require('./myzapLogger');

const SNAPSHOT_DIR_NAME = 'myzap-snapshot';
const SNAPSHOT_ZIP = 'myzap-snapshot.zip';
const SNAPSHOT_MANIFEST = 'myzap-snapshot.json';

function candidateBaseDirs() {
    const dirs = [];
    // App empacotado: extraResources ficam em resources/
    if (process.resourcesPath) {
        dirs.push(path.join(process.resourcesPath, SNAPSHOT_DIR_NAME));
    }
    // Dev: saida do scripts/build-myzap-snapshot.js
    dirs.push(path.join(__dirname, '..', '..', 'build', 'snapshot'));
    return dirs;
}

function readManifestSafe(manifestPath) {
    try {
        return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (_e) {
        return null;
    }
}

/**
 * Localiza o snapshot embutido utilizavel nesta maquina.
 * @returns {{ zipPath: string, manifest: object }|null}
 */
function getLocalSnapshotInfo() {
    const platform = `${process.platform}-${process.arch}`;

    for (const baseDir of candidateBaseDirs()) {
        const zipPath = path.join(baseDir, SNAPSHOT_ZIP);
        if (!fs.existsSync(zipPath)) continue;

        const manifest = readManifestSafe(path.join(baseDir, SNAPSHOT_MANIFEST)) || {};
        // Binarios nativos sao da plataforma onde o snapshot foi montado;
        // snapshot de outra plataforma e inutil aqui.
        if (manifest.platform && manifest.platform !== platform) {
            warn('localSnapshot: snapshot ignorado por plataforma incompativel', {
                metadata: { area: 'localSnapshot', zipPath, snapshotPlatform: manifest.platform, platform }
            });
            continue;
        }

        return { zipPath, manifest };
    }

    return null;
}

/**
 * Instala o MyZap extraindo o snapshot local para dirPath.
 * Nao mexe em .env/banco (o chamador roda o syncMyZapConfigs de sempre).
 * Lanca erro em falha — o chamador limpa o destino e cai para o fluxo de rede.
 *
 * @returns {Promise<{ sha: string|null, manifest: object }>}
 */
async function installFromLocalSnapshot(dirPath, options = {}) {
    const reportProgress = (typeof options.onProgress === 'function')
        ? options.onProgress
        : () => {};

    const snapshot = options.snapshot || getLocalSnapshotInfo();
    if (!snapshot) {
        throw new Error('Nenhum snapshot local do MyZap disponivel.');
    }

    if (fs.existsSync(dirPath) && fs.readdirSync(dirPath).length > 0) {
        // Erro TIPADO: o chamador precisa distinguir "destino nao era nosso"
        // (NUNCA limpar — pode ser uma pasta de dados do usuario) de uma
        // falha no meio da extracao (destino criado por nos, limpavel).
        const err = new Error('Erro ao preparar a instalacao do MyZap. Verifique se a pasta de destino ja existe e nao esta vazia.');
        err.code = 'EDESTINO_NAO_VAZIO';
        throw err;
    }

    reportProgress('Instalando MyZap do pacote embutido (sem internet)...', 'install_from_snapshot', {
        percent: 40,
        dirPath,
        sha: snapshot.manifest.sha || null
    });

    fs.mkdirSync(dirPath, { recursive: true });
    await extractZip(snapshot.zipPath, { dir: dirPath });

    // Mesma regra de "apto a rodar" do resto do ciclo de vida.
    // eslint-disable-next-line global-require
    const { isMyZapInstallComplete } = require('./iniciarMyZap');
    if (!isMyZapInstallComplete(dirPath)) {
        throw new Error('Snapshot extraido, mas a instalacao ficou incompleta.');
    }

    info('localSnapshot: MyZap instalado a partir do snapshot embutido', {
        metadata: {
            area: 'localSnapshot',
            dirPath,
            sha: snapshot.manifest.sha || null,
            generatedAt: snapshot.manifest.generatedAt || null
        }
    });

    return { sha: snapshot.manifest.sha || null, manifest: snapshot.manifest };
}

/**
 * Env extra para processos do MyZap: aponta o puppeteer para o Chromium que
 * veio DENTRO do snapshot. Sem o diretorio, devolve {} e nada muda — quem tem
 * Chrome instalado continua usando o Chrome (chrome-launcher), como hoje.
 */
function puppeteerCacheEnv(dirPath) {
    try {
        const cacheDir = path.join(dirPath, '.puppeteer-cache');
        if (dirPath && fs.existsSync(cacheDir)) {
            return { PUPPETEER_CACHE_DIR: cacheDir };
        }
    } catch (_e) { /* melhor esforco */ }
    return {};
}

module.exports = {
    getLocalSnapshotInfo,
    installFromLocalSnapshot,
    puppeteerCacheEnv
};
