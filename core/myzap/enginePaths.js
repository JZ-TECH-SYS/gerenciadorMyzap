/**
 * Caminhos do motor (v3, modelo Runtime Pack) — módulo FOLHA, sem requires de
 * outros módulos nossos, para qualquer um poder usar sem ciclo.
 *
 * Layout novo (pack):                Layout legado (snapshot/clone):
 *   <base>\myzap\        <- CÓDIGO     <base>\myzap\  <- código E dados juntos
 *     manifest.json                      (.env, database/, instances/ dentro)
 *     node\node.exe
 *     index.js, node_modules...
 *   <base>\myzap-data\    <- DADOS
 *     .env, database\, instances\
 *   <base>\myzap-packs\   <- cache de packs baixados (reparo offline)
 *
 * O modo é detectado pelo manifest.json no diretório do motor: presente =
 * pack (dados fora), ausente = legado (dados dentro — comportamento antigo
 * intocado). A migração de um layout para o outro é do enginePack.
 */

const fs = require('fs');
const path = require('path');

function readEngineManifest(engineDir) {
    try {
        if (!engineDir) return null;
        const raw = fs.readFileSync(path.join(engineDir, 'manifest.json'), 'utf8');
        const manifest = JSON.parse(raw);
        return (manifest && manifest.name === 'myzap-pack') ? manifest : null;
    } catch (_e) {
        return null;
    }
}

function isPackEngine(engineDir) {
    return readEngineManifest(engineDir) !== null;
}

/** node.exe embutido no pack, ou null (legado roda com Electron-as-Node). */
function getEngineNodeExe(engineDir) {
    try {
        const exe = path.join(engineDir, 'node', 'node.exe');
        return fs.existsSync(exe) ? exe : null;
    } catch (_e) {
        return null;
    }
}

/** Irmãos do diretório do motor. */
function getDataDirFor(engineDir) {
    return path.join(path.dirname(path.resolve(engineDir)), 'myzap-data');
}

function getPacksCacheDirFor(engineDir) {
    return path.join(path.dirname(path.resolve(engineDir)), 'myzap-packs');
}

/**
 * Onde moram os DADOS desta instalação (o .env, o sqlite, a sessão).
 * Pack => myzap-data ao lado; legado => o próprio diretório do motor.
 */
function resolveDataDir(engineDir) {
    return isPackEngine(engineDir) ? getDataDirFor(engineDir) : path.resolve(engineDir);
}

/** Entradas de DADOS que migram do layout legado para o myzap-data. */
const DATA_ENTRIES = [
    '.env',
    'database',
    'instances',
    'tokens',
    'userDataDir',
    '.wwebjs_cache'
];

module.exports = {
    DATA_ENTRIES,
    readEngineManifest,
    isPackEngine,
    getEngineNodeExe,
    getDataDirFor,
    getPacksCacheDirFor,
    resolveDataDir
};
