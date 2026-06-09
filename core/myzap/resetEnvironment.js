const fs = require('fs');
const path = require('path');
const Store = require('electron-store');
const { info, warn, error } = require('./myzapLogger');
const { killProcessesOnPort, isPortInUse, waitForPortFree } = require('./processUtils');
const { getDefaultMyZapDirectory } = require('./autoConfig');
const { killMyZapProcess } = require('./iniciarMyZap');
const { transition, forceTransition } = require('./stateMachine');
const { clearProgress } = require('./progress');
const { withLifecycleLock } = require('./opLock');

const store = new Store();
const KILL_RETRY_ATTEMPTS = 3;
const KILL_RETRY_DELAY_MS = 1000;

function unique(values = []) {
    return [...new Set(values.filter(Boolean).map((item) => String(item).trim()).filter(Boolean))];
}

function isSafeResetPath(targetPath) {
    if (!targetPath) return false;
    const normalized = path.resolve(String(targetPath));
    const lowered = normalized.toLowerCase();
    const base = path.basename(normalized).toLowerCase();

    if (base === 'myzap') return true;
    if (lowered.endsWith(`${path.sep}myzap`)) return true;
    if (lowered.includes(`${path.sep}myzap${path.sep}`)) return true;
    return false;
}

function removeDirectory(targetPath) {
    const normalized = path.resolve(String(targetPath));

    if (!isSafeResetPath(normalized)) {
        return {
            path: normalized,
            removed: false,
            skipped: true,
            reason: 'caminho_unsafe'
        };
    }

    if (!fs.existsSync(normalized)) {
        return {
            path: normalized,
            removed: false,
            skipped: true,
            reason: 'nao_existe'
        };
    }

    try {
        fs.rmSync(normalized, { recursive: true, force: true });
        return {
            path: normalized,
            removed: true,
            skipped: false
        };
    } catch (err) {
        return {
            path: normalized,
            removed: false,
            skipped: false,
            reason: err?.message || String(err)
        };
    }
}

function clearMyZapStoreKeys() {
    const keys = [
        'myzap_diretorio',
        'myzap_sessionKey',
        'myzap_sessionName',
        'myzap_apiToken',
        'myzap_envContent',
        'myzap_promptId',
        'myzap_iaAtiva',
        'myzap_mensagemPadrao',
        'myzap_modoIntegracao',
        'myzap_rodarLocal',
        'myzap_remoteConfigOk',
        'myzap_remoteConfigCheckedAt',
        'myzap_lastRemoteConfigSyncAt',
        'myzap_backendProfileKey',
        'myzap_backendApiUrl',
        'myzap_backendApiToken',
        'myzap_capabilityIaConfigMode',
        'myzap_capabilityTokenSyncMode',
        'myzap_capabilityPassiveStatusMode',
        'myzap_capabilityQueuePollingMode',
        'myzap_capabilitySnapshot',
        'myzap_capabilityRemoteHints',
        'myzap_progress',
        'clickexpress_apiUrl',
        'clickexpress_queueToken'
    ];

    keys.forEach((key) => store.delete(key));
    return keys;
}

async function resetMyZapEnvironment(options = {}) {
    // Reset compartilha o mutex de ciclo de vida: nunca roda por cima de uma
    // instalacao/start/recovery em andamento.
    return withLifecycleLock('reset', () => doResetMyZapEnvironment(options));
}

async function doResetMyZapEnvironment(options = {}) {
    const removeTools = Boolean(options.removeTools);
    const storedPath = String(store.get('myzap_diretorio') || '').trim();
    const defaultPath = getDefaultMyZapDirectory();
    const directories = unique([storedPath, defaultPath]);

    // Transitar para estado 'resetting'
    transition('resetting', { message: 'Resetando ambiente local do MyZap...', removeTools });

    info('Reset do ambiente local MyZap solicitado', {
        metadata: {
            area: 'resetEnvironment',
            removeTools,
            directories
        }
    });

    const errors = [];

    try {
        // 1. Matar child process rastreado
        try {
            killMyZapProcess();
        } catch (err) {
            errors.push(`killMyZapProcess: ${err?.message || String(err)}`);
        }

        // 2. Kill processos nas portas com retry
        const portsResult = [];
        for (const port of [5555, 3333]) {
            let result;
            for (let attempt = 1; attempt <= KILL_RETRY_ATTEMPTS; attempt++) {
                result = killProcessesOnPort(port);
                portsResult.push({ port, attempt, ...result });

                if (result.failed.length === 0) break;

                if (attempt < KILL_RETRY_ATTEMPTS) {
                    await new Promise((resolve) => setTimeout(resolve, KILL_RETRY_DELAY_MS));
                }
            }

            // Verificar se porta foi realmente liberada
            const stillInUse = await isPortInUse(port);
            if (stillInUse) {
                const msg = `Porta ${port} ainda em uso apos ${KILL_RETRY_ATTEMPTS} tentativas de kill`;
                warn(msg, { metadata: { area: 'resetEnvironment', port } });
                errors.push(msg);
            }
        }

        // 2b. Esperar a porta liberar de verdade (poll) antes de remover diretorios —
        // o sqlite/Node solta os file locks junto com o processo.
        await waitForPortFree(5555, { timeoutMs: 10000 });

        // 3. Remover diretorios
        const directoryResults = directories.map((dir) => removeDirectory(dir));

        // 4. Limpar store
        const clearedKeys = clearMyZapStoreKeys();

        // 4b. Limpar progresso ativo (evita stale)
        clearProgress();

        // 4c. Marcar que usuario removeu explicitamente (impede auto-install)
        store.set('myzap_userRemovedLocal', true);

        // 5. Remocao de Git/Node descontinuada: o gerenciador nao depende mais
        // de ferramentas externas (Node = shim do Electron, download = ZIP).
        let toolsResult = null;
        if (removeTools) {
            toolsResult = {
                attempted: false,
                status: 'warning',
                message: 'Remocao de Git/Node descontinuada: o Gerenciador nao instala mais essas ferramentas.'
            };
        }

        // Transitar para idle
        forceTransition('idle', { reason: 'reset_completo' });

        const response = {
            status: errors.length > 0 ? 'warning' : 'success',
            message: errors.length > 0
                ? `Reset executado com avisos: ${errors.join('; ')}`
                : removeTools
                    ? 'Reset completo executado. Verifique remocao de Git/Node nos detalhes.'
                    : 'Ambiente local do MyZap resetado com sucesso.',
            data: {
                directories: directoryResults,
                ports: portsResult,
                clearedKeys,
                tools: toolsResult,
                warnings: errors
            }
        };

        info('Reset do ambiente local MyZap concluido', {
            metadata: {
                area: 'resetEnvironment',
                removeTools,
                directoryResults,
                portsResult,
                toolsStatus: toolsResult?.status || null,
                warnings: errors
            }
        });

        return response;
    } catch (err) {
        // Em caso de erro critico, transitar para error
        forceTransition('error', { message: err?.message || String(err), phase: 'reset' });

        error('Erro ao resetar ambiente local MyZap', {
            metadata: {
                area: 'resetEnvironment',
                error: err,
                error_message: err?.message || String(err),
                error_stack: err?.stack || null
            }
        });
        return {
            status: 'error',
            message: err?.message || String(err)
        };
    }
}

module.exports = {
    resetMyZapEnvironment
};
