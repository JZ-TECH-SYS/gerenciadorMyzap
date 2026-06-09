const fs = require('fs');
const path = require('path');
const Store = require('electron-store');
const { warn, info } = require('../myzap/myzapLogger');
const { getLogDir } = require('../utils/logger');
const clonarRepositorio = require('../myzap/clonarRepositorio');
const verificarDiretorio = require('../myzap/verificarDiretorio');
const getConnectionStatus = require('../myzap/api/getConnectionStatus');
const startSession = require('../myzap/api/startSession');
const deleteSession = require('../myzap/api/deleteSession');
const verifyRealStatus = require('../myzap/api/verifyRealStatus');
const { getSessionSnapshot } = require('../myzap/api/getSessionSnapshot');
const { connectWithRecovery } = require('../myzap/api/connectSession');
const updateIaConfig = require('../myzap/api/updateIaConfig');
const { getMyZapApiBaseUrls } = require('../myzap/api/requestMyZapApi');
const { iniciarMyZap } = require('../myzap/iniciarMyZap');
const {
    prepareAutoConfig,
    getAutoConfigDebugSnapshot,
    ensureMyZapReadyAndStart
} = require('../myzap/autoConfig');
const { resetMyZapEnvironment } = require('../myzap/resetEnvironment');
const {
    getOrCreateLocalToken,
    buildEnvContent: buildTemplateEnvContent
} = require('../myzap/envTemplate');
const { getStateSnapshot } = require('../myzap/stateMachine');
const { getPrivilegeStatus } = require('../myzap/processUtils');
const {
    getUltimosPendentesMyZap,
    startWhatsappQueueWatcher,
    stopWhatsappQueueWatcher,
    getWhatsappQueueWatcherStatus,
    processarFilaUmaRodada
} = require('../api/whatsappQueueWatcher');

const envStore = new Store();

function isSetupInProgress() {
    const progress = envStore.get('myzap_progress');
    return progress && progress.active === true;
}

function parseEnvSecrets(envContent) {
    const secrets = { TOKEN: '', OPENAI_API_KEY: '', EMAIL_TOKEN: '' };
    if (!envContent) return secrets;
    const lines = String(envContent).split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
        const eqIdx = trimmed.indexOf('=');
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        // Remove aspas
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        if (key === 'TOKEN' || key === 'OPENAI_API_KEY' || key === 'EMAIL_TOKEN') {
            secrets[key] = val;
        }
    }
    return secrets;
}

function registerMyZapHandlers(ipcMain) {
    info('IPC MyZap handlers registrados', {
        metadata: { area: 'ipcMyzap' }
    });

    ipcMain.handle('myzap:checkDirectoryHasFiles', async (event, dirPath) => {
        try {
            const result = await verificarDiretorio(dirPath);
            return result;
        } catch (error) {
            warn('Falha ao verificar diretório via IPC', {
                metadata: { error }
            });
            return {
                status: 'error',
                message: error.message || String(error)
            };
        }
    });

    ipcMain.handle('myzap:cloneRepository', async (event, dirPath, envContent, reinstall = false) => {
        if (isSetupInProgress()) {
            warn('Clone bloqueado: setup ja em andamento', { metadata: { area: 'ipcMyzap' } });
            return { status: 'error', message: 'Uma instalacao/atualizacao ja esta em andamento. Aguarde.' };
        }
        try {
            const result = await clonarRepositorio(dirPath, envContent, reinstall);
            return result;
        } catch (error) {
            warn('Falha ao clonar repositório via IPC', {
                metadata: { error }
            });
            return {
                status: 'error',
                message: error.message || String(error)
            };
        }
    });

    ipcMain.handle('myzap:iniciarMyZap', async (event, dirPath) => {
        try {
            const result = await iniciarMyZap(dirPath);
            return result;
        } catch (error) {
            warn('Falha ao iniciar MyZap via IPC', {
                metadata: { error }
            });
            return {
                status: 'error',
                message: error.message || String(error)
            };
        }
    });

    ipcMain.handle('myzap:prepareAutoConfig', async (_event, forceRemote = false) => {
        try {
            info('IPC myzap:prepareAutoConfig recebido', {
                metadata: { area: 'ipcMyzap', forceRemote }
            });
            return await prepareAutoConfig({ forceRemote });
        } catch (error) {
            warn('Falha ao preparar configuracao automatica do MyZap via IPC', {
                metadata: { error }
            });
            return {
                status: 'error',
                message: error.message || String(error)
            };
        }
    });

    ipcMain.handle('myzap:getAutoConfigDebug', async () => {
        try {
            return getAutoConfigDebugSnapshot();
        } catch (error) {
            warn('Falha ao obter debug da configuracao automatica MyZap via IPC', {
                metadata: { error }
            });
            return {
                generatedAt: Date.now(),
                success: false,
                reason: 'ipc_error',
                error: error.message || String(error),
                attempts: []
            };
        }
    });

    ipcMain.handle('myzap:getPrivilegeStatus', async () => {
        try {
            return getPrivilegeStatus();
        } catch (error) {
            warn('Falha ao verificar privilegios do processo via IPC', {
                metadata: { error }
            });
            return {
                platform: process.platform,
                isElevated: false,
                requiresAdminForLocalInstall: false,
                needsAdminForLocalInstall: false,
                method: 'ipc_error',
                message: error.message || String(error)
            };
        }
    });

    ipcMain.handle('myzap:ensureStarted', async (_event, forceRemote = false) => {
        try {
            info('IPC myzap:ensureStarted recebido', {
                metadata: { area: 'ipcMyzap', forceRemote }
            });
            return await ensureMyZapReadyAndStart({ forceRemote });
        } catch (error) {
            warn('Falha ao iniciar MyZap automaticamente via IPC', {
                metadata: { error }
            });
            return {
                status: 'error',
                message: error.message || String(error)
            };
        }
    });

    ipcMain.handle('myzap:getConnectionStatus', async (event) => {
        try {
            const result = await getConnectionStatus();
            return result;
        } catch (error) {
            warn('Falha ao verificar conexão MyZap via IPC', {
                metadata: { error }
            });
            return {
                status: 'error',
                message: error.message || String(error)
            };
        }
    });

    ipcMain.handle('myzap:verifyRealStatus', async (event) => {
        try {
            const result = await verifyRealStatus();
            return result;
        } catch (error) {
            warn('Falha ao verificar status real MyZap via IPC', {
                metadata: { error }
            });
            return {
                status: 'error',
                message: error.message || String(error)
            };
        }
    });

    ipcMain.handle('myzap:startSession', async (event) => {
        try {
            const result = await startSession();
            return result;
        } catch (error) {
            warn('Falha ao verificar conexão MyZap via IPC', {
                metadata: { error }
            });
            return {
                status: 'error',
                message: error.message || String(error)
            };
        }
    });

    ipcMain.handle('myzap:getSessionSnapshot', async () => {
        try {
            return await getSessionSnapshot();
        } catch (error) {
            warn('Falha ao consolidar snapshot de sessao via IPC', {
                metadata: { error }
            });
            return {
                status: 'error',
                session_status: 'unknown',
                qr_base64: null,
                message: error.message || String(error)
            };
        }
    });

    ipcMain.handle('myzap:connectSession', async () => {
        try {
            return await connectWithRecovery();
        } catch (error) {
            warn('Falha ao conectar sessao com recuperacao via IPC', {
                metadata: { error }
            });
            return {
                status: 'error',
                sessionStatus: 'unknown',
                qrCode: null,
                message: error.message || String(error)
            };
        }
    });

    ipcMain.handle('myzap:forceReconnect', async () => {
        try {
            info('IPC myzap:forceReconnect recebido', {
                metadata: { area: 'ipcMyzap' }
            });
            return await connectWithRecovery({ forceCloseFirst: true });
        } catch (error) {
            warn('Falha ao forcar reconexao via IPC', {
                metadata: { error }
            });
            return {
                status: 'error',
                sessionStatus: 'unknown',
                qrCode: null,
                message: error.message || String(error)
            };
        }
    });

    ipcMain.handle('myzap:deleteSession', async (event) => {
        try {
            const result = await deleteSession();
            return result;
        } catch (error) {
            warn('Falha ao verificar conexão MyZap via IPC', {
                metadata: { error }
            });
            return {
                status: 'error',
                message: error.message || String(error)
            };
        }
    });

    ipcMain.handle('myzap:updateIaConfig', async (event, mensagemPadrao) => {
        try {
            const result = await updateIaConfig(mensagemPadrao);
            return result;
        } catch (error) {
            warn('Falha ao atualizar configuracao de IA MyZap via IPC', {
                metadata: { error }
            });
            return {
                status: 'error',
                message: error.message || String(error)
            };
        }
    });

    ipcMain.handle('myzap:startQueueWatcher', async () => {
        try {
            info('IPC myzap:startQueueWatcher recebido', {
                metadata: { area: 'ipcMyzap' }
            });
            return await startWhatsappQueueWatcher();
        } catch (error) {
            warn('Falha ao iniciar watcher de fila MyZap via IPC', {
                metadata: { error }
            });
            return {
                status: 'error',
                message: error.message || String(error)
            };
        }
    });

    ipcMain.handle('myzap:stopQueueWatcher', async () => {
        try {
            info('IPC myzap:stopQueueWatcher recebido', {
                metadata: { area: 'ipcMyzap' }
            });
            return stopWhatsappQueueWatcher();
        } catch (error) {
            warn('Falha ao parar watcher de fila MyZap via IPC', {
                metadata: { error }
            });
            return {
                status: 'error',
                message: error.message || String(error)
            };
        }
    });

    ipcMain.handle('myzap:getQueueWatcherStatus', async () => {
        try {
            return getWhatsappQueueWatcherStatus();
        } catch (error) {
            warn('Falha ao obter status do watcher de fila MyZap via IPC', {
                metadata: { error }
            });
            return {
                ativo: false,
                processando: false,
                ultimoLote: 0,
                ultimaExecucaoEm: null,
                ultimoErro: error.message || String(error)
            };
        }
    });

    ipcMain.handle('myzap:getQueuePendentes', async () => {
        try {
            return getUltimosPendentesMyZap();
        } catch (error) {
            warn('Falha ao obter pendentes da fila MyZap via IPC', {
                metadata: { error }
            });
            return [];
        }
    });

    ipcMain.handle('myzap:forceQueueCycle', async () => {
        try {
            info('IPC myzap:forceQueueCycle recebido (busca manual)', {
                metadata: { area: 'ipcMyzap' }
            });
            await processarFilaUmaRodada();
            return { status: 'success', message: 'Ciclo executado com sucesso.' };
        } catch (error) {
            warn('Falha ao forcar ciclo da fila MyZap via IPC', {
                metadata: { error }
            });
            return { status: 'error', message: error.message || String(error) };
        }
    });

    ipcMain.handle('myzap:getQueueLogs', async (_event, maxLines = 80) => {
        try {
            const logDir = getLogDir();
            const today = new Date().toISOString().split('T')[0];
            // Lê tanto o canal 'myzap' (envio) quanto o 'backend' (chamadas a API),
            // pois os logs de busca de pendentes / atualizacao de status passaram
            // para o canal backend e antes sumiam deste painel.
            const arquivos = [
                path.join(logDir, `${today}-log-myzap.jsonl`),
                path.join(logDir, `${today}-log-backend.jsonl`),
            ];
            const parsed = [];
            for (const logFile of arquivos) {
                if (!fs.existsSync(logFile)) continue;
                const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
                for (const line of lines) {
                    try { parsed.push(JSON.parse(line)); } catch (_e) { /* ignora linha invalida */ }
                }
            }
            // Filtra apenas o que é relevante à fila (worker + chamadas ao backend).
            const filaOnly = parsed.filter((e) => {
                const msg = e.message || '';
                const area = e.metadata?.area || '';
                const categoria = e.metadata?.categoria || '';
                return msg.includes('[FilaMyZap]')
                    || msg.includes('[Backend]')
                    || area === 'whatsappQueueWatcher'
                    || ['fila', 'envio', 'conexao', 'erro'].includes(categoria);
            });
            // Ordena por timestamp (mescla os dois arquivos) e pega as últimas linhas.
            filaOnly.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
            return filaOnly.slice(-maxLines);
        } catch (error) {
            warn('Falha ao ler logs da fila MyZap via IPC', {
                metadata: { error }
            });
            return [];
        }
    });

    // ── .env secrets handlers ──────────────────────────────

    ipcMain.handle('myzap:resetEnvironment', async (_event, options = {}) => {
        try {
            info('IPC myzap:resetEnvironment recebido', {
                metadata: { area: 'ipcMyzap', options }
            });
            return await resetMyZapEnvironment(options);
        } catch (error) {
            warn('Falha ao resetar ambiente MyZap via IPC', {
                metadata: { error }
            });
            return {
                status: 'error',
                message: error.message || String(error)
            };
        }
    });

    // Envia uma mensagem de TESTE pro numero informado (use o proprio numero para
    // validar o envio sem incomodar clientes). POST direto no /sendText do MyZap local.
    ipcMain.handle('myzap:sendTestMessage', async (_event, numeroRaw, textoRaw) => {
        try {
            const sessionKey = String(envStore.get('myzap_sessionKey') || '').trim();
            const apiToken = String(envStore.get('myzap_apiToken') || '').trim();
            const numero = String(numeroRaw || '').replace(/\D/g, '');
            const texto = String(textoRaw || '').trim()
                || 'Teste de envio do Gerenciador MyZap. Se voce recebeu, o envio esta funcionando.';

            if (!sessionKey || !apiToken) {
                return { status: 'error', message: 'Sessao/token do MyZap nao configurados. Conecte o MyZap primeiro.' };
            }
            if (numero.length < 8) {
                return { status: 'error', message: 'Informe um numero valido com DDD e pais. Ex: 5511999999999' };
            }

            envStore.set('myzap_testNumber', numero); // prefill na proxima vez

            const baseUrls = getMyZapApiBaseUrls();
            let lastError = null;
            for (const api of baseUrls) {
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), 20000);
                try {
                    const res = await fetch(`${api}sendText`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            apitoken: apiToken,
                            sessionkey: sessionKey
                        },
                        body: JSON.stringify({ session: sessionKey, number: numero, text: texto }),
                        signal: ctrl.signal
                    });
                    const data = await res.json().catch(() => ({}));
                    clearTimeout(timer);
                    if (!res.ok || data?.error) {
                        return { status: 'error', message: data?.error || `Falha no envio (HTTP ${res.status}).` };
                    }
                    info('IPC myzap:sendTestMessage enviado', { metadata: { area: 'ipcMyzap', numero } });
                    return { status: 'success', message: `Mensagem de teste enviada para ${numero}.` };
                } catch (e) {
                    clearTimeout(timer);
                    lastError = e;
                }
            }
            return {
                status: 'error',
                message: `MyZap indisponivel para enviar: ${(lastError && lastError.message) || 'sem resposta'}`
            };
        } catch (error) {
            warn('Falha no envio de teste via IPC', { metadata: { error } });
            return { status: 'error', message: error.message || String(error) };
        }
    });

    ipcMain.handle('myzap:getStateSnapshot', async () => {
        try {
            return getStateSnapshot();
        } catch (error) {
            warn('Falha ao obter snapshot de estado MyZap via IPC', {
                metadata: { error }
            });
            return {
                state: 'error',
                label: 'Erro',
                progress: 0,
                error: error.message || String(error)
            };
        }
    });

    // ── .env secrets handlers (continuacao) ─────────────────
    ipcMain.handle('myzap:saveEnvSecrets', async (_event, secrets) => {
        try {
            const { TOKEN = '', OPENAI_API_KEY = '', EMAIL_TOKEN = '' } = secrets || {};
            const myzapDir = String(envStore.get('myzap_diretorio') || '').trim();
            const localEnvPath = (myzapDir && fs.existsSync(path.join(myzapDir, '.env')))
                ? path.join(myzapDir, '.env')
                : '';

            // Base: store -> .env instalado -> template gerado em codigo.
            // (O antigo template em disco morreu junto com os segredos comitados;
            // em producao ele ficava dentro do app.asar e a escrita falhava.)
            const storedEnv = String(envStore.get('myzap_envContent') || '').trim();
            const installedEnv = localEnvPath ? fs.readFileSync(localEnvPath, 'utf8') : '';
            let baseEnv = storedEnv || installedEnv || buildTemplateEnvContent({
                token: TOKEN || getOrCreateLocalToken(envStore, myzapDir),
                openaiKey: OPENAI_API_KEY,
                emailToken: EMAIL_TOKEN
            });

            baseEnv = baseEnv.replace(/^TOKEN=.*$/m, `TOKEN="${TOKEN}"`);
            baseEnv = baseEnv.replace(/^OPENAI_API_KEY=.*$/m, `OPENAI_API_KEY="${OPENAI_API_KEY}"`);
            baseEnv = baseEnv.replace(/^EMAIL_TOKEN=.*$/m, `EMAIL_TOKEN="${EMAIL_TOKEN}"`);
            envStore.set('myzap_envContent', baseEnv);

            // Sincronizar myzap_apiToken/localToken com o TOKEN para que as
            // chamadas HTTP a API local usem o mesmo valor
            if (TOKEN) {
                envStore.set('myzap_apiToken', TOKEN);
                envStore.set('myzap_localToken', TOKEN);
                info('myzap_apiToken sincronizado com TOKEN do .env', {
                    metadata: { area: 'ipcMyzap' }
                });
            }

            if (!localEnvPath) {
                info('Segredos salvos no store (MyZap ainda nao instalado)', {
                    metadata: { area: 'ipcMyzap' }
                });
                return { status: 'success', message: 'Segredos salvos. Instale o MyZap para aplicar.' };
            }

            fs.writeFileSync(localEnvPath, baseEnv, 'utf8');
            info('Segredos .env salvos com sucesso', {
                metadata: { area: 'ipcMyzap' }
            });
            return { status: 'success', message: 'Segredos salvos com sucesso.' };
        } catch (error) {
            warn('Falha ao salvar segredos .env via IPC', { metadata: { error } });
            return { status: 'error', message: error.message || String(error) };
        }
    });

    ipcMain.handle('myzap:readEnvSecrets', async () => {
        try {
            const myzapDir = String(envStore.get('myzap_diretorio') || '').trim();
            const localEnv = myzapDir ? path.join(myzapDir, '.env') : '';
            let envContent = '';
            if (localEnv && fs.existsSync(localEnv)) {
                envContent = fs.readFileSync(localEnv, 'utf8');
            }
            // Fallback ao store: apos reset os arquivos sao apagados,
            // mas myzap_envContent ainda guarda os segredos configurados
            if (!envContent || !envContent.includes('TOKEN=')) {
                const storeEnv = String(envStore.get('myzap_envContent') || '');
                if (storeEnv) envContent = storeEnv;
            }
            return parseEnvSecrets(envContent);
        } catch (error) {
            warn('Falha ao ler segredos .env via IPC', { metadata: { error } });
            return { TOKEN: '', OPENAI_API_KEY: '', EMAIL_TOKEN: '' };
        }
    });

    ipcMain.handle('myzap:clearUserRemovedFlag', async () => {
        try {
            envStore.delete('myzap_userRemovedLocal');
            info('Flag myzap_userRemovedLocal removida pelo usuario (re-install solicitado)', {
                metadata: { area: 'ipcMyzap' }
            });
            return { status: 'success' };
        } catch (error) {
            warn('Falha ao limpar flag userRemovedLocal via IPC', { metadata: { error } });
            return { status: 'error', message: error.message || String(error) };
        }
    });
}

module.exports = {
    registerMyZapHandlers
};
