const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { error: logError, info, warn } = require('./myzapLogger');
const { isPortInUse, getPnpmCommand } = require('./processUtils');
const { transition } = require('./stateMachine');

/** Referencia ao child process ativo do MyZap (pnpm start) */
let myzapChildProcess = null;

/**
 * Mata o child process rastreado do MyZap, se existir.
 */
function killMyZapProcess() {
    if (!myzapChildProcess) {
        info('killMyZapProcess: nenhum child process rastreado para matar', {
            metadata: { area: 'iniciarMyZap' }
        });
        return;
    }

    try {
        const pid = myzapChildProcess.pid;
        myzapChildProcess.kill('SIGTERM');
        info('killMyZapProcess: SIGTERM enviado ao child process do MyZap', {
            metadata: { area: 'iniciarMyZap', pid }
        });
    } catch (err) {
        warn('killMyZapProcess: falha ao matar child process', {
            metadata: { area: 'iniciarMyZap', error: err?.message || String(err) }
        });
    } finally {
        myzapChildProcess = null;
    }
}

function executarComando(comando, args, cwd) {
    return new Promise((resolve, reject) => {
        const child = spawn(comando, args, { cwd, shell: true });

        let stderr = '';

        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(stderr.trim() || `Comando "${comando}" finalizou com codigo ${code}.`));
        });
    });
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function aguardarPorta(porta, timeoutMs = 20000, intervalMs = 500) {
    const inicio = Date.now();
    while (Date.now() - inicio < timeoutMs) {
        if (await isPortInUse(porta)) {
            return true;
        }
        await wait(intervalMs);
    }
    return false;
}

async function iniciarMyZap(dirPath, options = {}) {
    try {
        const reportProgress = (typeof options.onProgress === 'function')
            ? options.onProgress
            : () => {};
        const porta = 5555;

        transition('starting_service', { message: 'Validando se o MyZap ja esta em execucao...', dirPath });

        reportProgress('Validando se o MyZap ja esta em execucao...', 'check_runtime', {
            percent: 86,
            dirPath,
            porta
        });
        const estaRodando = await isPortInUse(porta);

        if (estaRodando) {
            transition('running', { message: 'MyZap ja estava em execucao local.', dirPath, porta });
            reportProgress('MyZap ja estava em execucao local.', 'already_running', {
                percent: 95,
                dirPath,
                porta
            });
            return {
                status: 'success',
                message: 'O MyZap ja esta em execucao.'
            };
        }

        reportProgress('Atualizando codigo local do MyZap (git pull)...', 'git_pull', {
            percent: 90,
            dirPath
        });
        const gitDir = path.join(dirPath, '.git');
        if (fs.existsSync(gitDir)) {
            try {
                await executarComando('git', ['pull', 'origin', 'main'], dirPath);
            } catch (gitErr) {
                info('git pull falhou (nao-critico, continuando)', {
                    metadata: { area: 'iniciarMyZap', error: gitErr?.message || String(gitErr) }
                });
            }
        } else {
            info('Diretorio .git nao encontrado, pulando git pull', {
                metadata: { area: 'iniciarMyZap', dirPath }
            });
        }

        const pnpmRunner = await getPnpmCommand();
        if (!pnpmRunner) {
            return {
                status: 'error',
                message: 'PNPM/NPX nao encontrado. Instale Node.js com npm/npx ou PNPM.'
            };
        }

        reportProgress('Subindo processo do MyZap (pnpm start)...', 'run_start', {
            percent: 93,
            dirPath
        });
        const child = spawn(pnpmRunner.command, [...pnpmRunner.prefixArgs, 'start'], {
            cwd: dirPath,
            shell: true,
            detached: false
        });

        // Rastrear child process para kill posterior
        myzapChildProcess = child;

        child.stdout.on('data', (data) => {
            info('MyZap runtime stdout', {
                metadata: {
                    area: 'iniciarMyZap',
                    output: String(data).trim()
                }
            });
        });
        let stderrOutput = '';

        child.stderr.on('data', (data) => {
            const text = String(data).trim();
            stderrOutput += (stderrOutput ? '\n' : '') + text;
            info('MyZap runtime stderr', {
                metadata: {
                    area: 'iniciarMyZap',
                    output: text
                }
            });
        });

        let childError = null;

        child.on('error', (err) => {
            childError = err;
        });

        child.on('exit', (code, signal) => {
            if (typeof code === 'number' && code !== 0) {
                // Extrair primeira linha util do stderr (sem stack trace)
                const firstLine = stderrOutput
                    .split('\n')
                    .map(l => l.trim())
                    .find(l => l && !l.startsWith('at ') && !l.startsWith('node:'));
                const detail = firstLine || stderrOutput.slice(0, 200);
                const msg = detail
                    ? `MyZap finalizou com codigo ${code}: ${detail}`
                    : `MyZap finalizou com codigo ${code} (signal: ${signal || 'nenhum'})`;
                childError = new Error(msg);
            }
            // Limpar referencia do child ao sair
            if (myzapChildProcess === child) {
                myzapChildProcess = null;
            }
        });

        reportProgress('Aguardando MyZap abrir a porta local...', 'wait_port', {
            percent: 96,
            dirPath,
            porta
        });
        const abriuPorta = await aguardarPorta(porta, 20000, 500);

        if (!abriuPorta) {
            transition('error', {
                message: childError
                    ? `Falha ao iniciar: ${childError.message}`
                    : `MyZap nao abriu a porta ${porta} dentro do tempo esperado.`,
                phase: 'start_service'
            });
            return {
                status: 'error',
                message: childError
                    ? `Falha ao iniciar: ${childError.message}`
                    : `MyZap nao abriu a porta ${porta} dentro do tempo esperado.`
            };
        }

        transition('running', { message: 'MyZap iniciado e porta confirmada.', dirPath, porta });

        info('MyZap iniciado e porta confirmada', {
            metadata: { porta, dirPath, runner: pnpmRunner.command }
        });
        reportProgress('MyZap iniciado e porta confirmada.', 'ready', {
            percent: 98,
            dirPath,
            porta
        });

        return {
            status: 'success',
            message: 'MyZap iniciado com sucesso!'
        };
    } catch (err) {
        transition('error', { message: err?.message || String(err), phase: 'start_service' });
        logError('Erro ao gerenciar inicio do MyZap', { metadata: { error: err } });
        return {
            status: 'error',
            message: `Erro: ${err.message}`
        };
    }
}

module.exports = { iniciarMyZap, killMyZapProcess };
