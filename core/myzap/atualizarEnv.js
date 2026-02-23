const { iniciarMyZap } = require('./iniciarMyZap');
const { info, warn, error } = require('./myzapLogger');
const { killProcessesOnPort, isPortInUse } = require('./processUtils');
const { syncMyZapConfigs } = require('./syncConfigs');
const { transition } = require('./stateMachine');

async function atualizarEnv(dirPath, envContent, options = {}) {
    try {
        const reportProgress = (typeof options.onProgress === 'function')
            ? options.onProgress
            : () => {};

        transition('starting_service', { message: 'Sincronizando configuracoes e reiniciando servico...', dirPath });

        reportProgress('Sincronizando configuracoes locais do MyZap (.env/banco)...', 'sync_configs', {
            percent: 65,
            dirPath
        });
        const syncResult = syncMyZapConfigs(dirPath, {
            envContent,
            overwriteDb: false
        });

        if (syncResult.status === 'error') {
            return syncResult;
        }

        reportProgress('Reiniciando servico local para aplicar configuracoes...', 'restart_service', {
            percent: 78,
            dirPath
        });
        const killResult = killProcessesOnPort(5555);
        if (killResult.killed.length > 0) {
            info('Processos finalizados na porta 5555 para reinicio do MyZap', {
                metadata: { killed: killResult.killed }
            });
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        if (killResult.failed.length > 0) {
            warn('Nao foi possivel finalizar alguns processos na porta 5555', {
                metadata: { failed: killResult.failed }
            });
        }

        const portaAindaOcupada = await isPortInUse(5555);
        if (portaAindaOcupada) {
            return {
                status: 'error',
                message: 'Porta 5555 ainda em uso. Feche o processo atual do MyZap e tente novamente.'
            };
        }

        reportProgress('Iniciando MyZap local...', 'start_service', {
            percent: 88,
            dirPath
        });
        const result = await iniciarMyZap(dirPath, {
            onProgress: reportProgress
        });

        if (result.status === 'error') {
            return result;
        }

        return {
            status: 'success',
            message: 'Configuracoes aplicadas e servico reiniciado!'
        };
    } catch (err) {
        transition('error', { message: err?.message || String(err), phase: 'atualizar_env' });
        error('Erro ao atualizar .env', { metadata: { error: err } });
        return { status: 'error', message: `Erro ao atualizar: ${err.message}` };
    }
}

module.exports = atualizarEnv;
