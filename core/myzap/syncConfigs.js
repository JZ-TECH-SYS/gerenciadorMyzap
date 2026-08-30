const fs = require('fs');
const path = require('path');
const Store = require('electron-store');
const { info, warn, error } = require('./myzapLogger');
const { getOrCreateLocalToken, buildEnvContent } = require('./envTemplate');
const { resolveDataDir } = require('./enginePaths');

const store = new Store();

function getSeedDbPath(engineDir) {
    // Semente do banco: preferir a do PACK (gerada pelas migrations no CI —
    // sempre em dia com o codigo daquela versao). O db.seed.sqlite embutido
    // no app fica como ultimo recurso para instalacoes legadas.
    const packSeed = path.join(engineDir, 'seed', 'db.sqlite');
    if (fs.existsSync(packSeed)) return packSeed;
    return path.join(__dirname, 'configs', 'db.seed.sqlite');
}

function syncMyZapConfigs(dirPath, options = {}) {
    try {
        if (!dirPath || !fs.existsSync(dirPath)) {
            return {
                status: 'error',
                message: 'Projeto MyZap nao encontrado no diretorio informado.'
            };
        }

        const overwriteDb = Boolean(options.overwriteDb);
        const envContent = String(options.envContent || '').trim();

        // .env e banco moram no diretorio de DADOS: no pack e o myzap-data ao
        // lado (update de motor nunca encosta); no legado resolve para o
        // proprio dirPath (comportamento antigo intacto).
        const dataDir = resolveDataDir(dirPath);
        fs.mkdirSync(dataDir, { recursive: true });

        const envDest = path.join(dataDir, '.env');
        // Sem conteudo explicito, gera o template em codigo com o TOKEN unico
        // desta maquina (o antigo .env comitado com TOKEN compartilhado morreu).
        const envToWrite = envContent || buildEnvContent({
            token: getOrCreateLocalToken(store, dirPath)
        });

        if (!envToWrite) {
            return {
                status: 'error',
                message: 'Nao foi possivel montar o conteudo do .env do MyZap.'
            };
        }

        fs.writeFileSync(envDest, envToWrite, 'utf8');

        const dbOrigem = getSeedDbPath(dirPath);
        const dbDestDir = path.join(dataDir, 'database');
        const dbDestFile = path.join(dbDestDir, 'db.sqlite');
        let dbCopied = false;
        let dbSkipped = false;

        if (!fs.existsSync(dbDestDir)) {
            fs.mkdirSync(dbDestDir, { recursive: true });
        }

        if (fs.existsSync(dbOrigem)) {
            const shouldCopyDb = overwriteDb || !fs.existsSync(dbDestFile);
            if (shouldCopyDb) {
                fs.copyFileSync(dbOrigem, dbDestFile);
                dbCopied = true;
            } else {
                dbSkipped = true;
            }
        } else {
            warn('Banco de dados base nao encontrado em core/myzap/configs/db.seed.sqlite', {
                metadata: { dbOrigem }
            });
        }

        info('Arquivos base do MyZap sincronizados', {
            metadata: {
                dirPath,
                envDest,
                dbDestFile,
                dbCopied,
                dbSkipped,
                overwriteDb
            }
        });

        return {
            status: 'success',
            message: 'Arquivos base do MyZap sincronizados com sucesso.',
            data: {
                envDest,
                dbDestFile,
                dbCopied,
                dbSkipped
            }
        };
    } catch (err) {
        error('Erro ao sincronizar arquivos base do MyZap', {
            metadata: { error: err, dirPath }
        });
        return {
            status: 'error',
            message: `Erro ao sincronizar arquivos base: ${err.message}`
        };
    }
}

module.exports = {
    syncMyZapConfigs
};
