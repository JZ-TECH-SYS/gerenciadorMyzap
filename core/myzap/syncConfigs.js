const fs = require('fs');
const path = require('path');
const { info, warn, error } = require('./myzapLogger');

function getBundledEnvPath() {
    return path.join(__dirname, 'configs', '.env');
}

function getBundledDbPath() {
    return path.join(__dirname, 'configs', 'db.sqlite');
}

function readBundledEnv() {
    const envPath = getBundledEnvPath();
    if (!fs.existsSync(envPath)) {
        return '';
    }
    return fs.readFileSync(envPath, 'utf8');
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

        const envDest = path.join(dirPath, '.env');
        const bundledEnv = String(readBundledEnv() || '').trim();
        const envToWrite = envContent || bundledEnv;

        if (!envToWrite) {
            return {
                status: 'error',
                message: 'Arquivo .env padrao nao encontrado em core/myzap/configs/.env.'
            };
        }

        fs.writeFileSync(envDest, envToWrite, 'utf8');

        const dbOrigem = getBundledDbPath();
        const dbDestDir = path.join(dirPath, 'database');
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
            warn('Banco de dados base nao encontrado em core/myzap/configs/db.sqlite', {
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
