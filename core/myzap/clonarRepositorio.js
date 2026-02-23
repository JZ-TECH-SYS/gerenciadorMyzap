const { spawn } = require('child_process');
const { error: logError, warn, info } = require('./myzapLogger');
const path = require('path');
const fs = require('fs');
const { killProcessesOnPort, commandExists, getPnpmCommand } = require('./processUtils');
const { iniciarMyZap } = require('./iniciarMyZap');
const { syncMyZapConfigs } = require('./syncConfigs');
const { transition } = require('./stateMachine');

function rodarComando(comando, args, opcoes = {}) {
    return new Promise((resolve) => {
        const proc = spawn(comando, args, { shell: true, ...opcoes });

        proc.stdout.on('data', (data) => {
            info('MyZap comando stdout', {
                metadata: {
                    area: 'clonarRepositorio',
                    comando,
                    output: String(data).trim()
                }
            });
        });
        proc.stderr.on('data', (data) => {
            warn('MyZap comando stderr', {
                metadata: {
                    area: 'clonarRepositorio',
                    comando,
                    output: String(data).trim()
                }
            });
        });

        proc.on('close', (code) => resolve(code === 0));
        proc.on('error', () => resolve(false));
    });
}

async function clonarRepositorio(dirPath, envContent, reinstall = false, options = {}) {
    try {
        const reportProgress = (typeof options.onProgress === 'function')
            ? options.onProgress
            : () => {};

        reportProgress('Validando pre-requisitos locais (Git/Node/PNPM)...', 'precheck', {
            percent: 10,
            dirPath
        });

        transition('checking_config', { message: 'Verificando pre-requisitos locais...', dirPath });

        if (!(await commandExists('git'))) {
            return {
                status: 'error',
                message: 'Git nao encontrado no sistema. Instale o Git e tente novamente.'
            };
        }

        if (!(await commandExists('node'))) {
            return {
                status: 'error',
                message: 'Node.js nao encontrado no sistema. Instale o Node.js e tente novamente.'
            };
        }

        const pnpmRunner = await getPnpmCommand();
        if (!pnpmRunner) {
            return {
                status: 'error',
                message: 'PNPM/NPX nao encontrado. Instale Node.js com npm/npx ou PNPM.'
            };
        }

        if (reinstall) {
            reportProgress('Reinstalacao solicitada. Limpando instalacao anterior...', 'reinstall_cleanup', {
                percent: 20,
                dirPath
            });
            info('Iniciando modo de reinstalacao do MyZap', { metadata: { dirPath } });

            const killResult = killProcessesOnPort(5555);
            if (killResult.failed.length > 0) {
                warn('Nao foi possivel finalizar alguns processos na porta 5555', {
                    metadata: { failed: killResult.failed }
                });
            }

            await new Promise((resolve) => setTimeout(resolve, 500));

            if (fs.existsSync(dirPath)) {
                try {
                    fs.rmSync(dirPath, { recursive: true, force: true });
                } catch (err) {
                    logError('Erro ao remover pasta do MyZap na reinstalacao', { metadata: { err, dirPath } });
                    return {
                        status: 'error',
                        message: `Falha ao remover diretorio atual do MyZap: ${err.message}`
                    };
                }
            }
        }

        const repoUrl = 'https://github.com/JZ-TECH-SYS/myzap.git';
        fs.mkdirSync(path.dirname(dirPath), { recursive: true });

        transition('cloning_repo', { message: 'Clonando repositorio do MyZap...', dirPath });

        reportProgress('Baixando projeto MyZap (git clone)...', 'clone_repo', {
            percent: 35,
            dirPath
        });
        const clonou = await rodarComando('git', ['clone', repoUrl, dirPath]);

        if (!clonou) {
            return { status: 'error', message: 'Erro ao clonar o repositorio. Verifique se a pasta ja existe.' };
        }

        transition('installing_dependencies', { message: 'Instalando dependencias do MyZap...', dirPath });

        reportProgress('Instalando dependencias do MyZap (pnpm install)...', 'install_dependencies', {
            percent: 55,
            dirPath
        });
        const instalouDeps = await rodarComando(
            pnpmRunner.command,
            [...pnpmRunner.prefixArgs, 'install'],
            { cwd: dirPath }
        );

        if (!instalouDeps) {
            return {
                status: 'error',
                message: 'Repositorio clonado, mas houve erro ao instalar dependencias do MyZap.'
            };
        }

        reportProgress('Aplicando configuracoes locais (.env e banco base)...', 'sync_configs', {
            percent: 75,
            dirPath
        });
        const syncResult = syncMyZapConfigs(dirPath, {
            envContent,
            overwriteDb: true
        });

        if (syncResult.status === 'error') {
            return syncResult;
        }

        reportProgress('Iniciando servico local do MyZap...', 'start_service', {
            percent: 88,
            dirPath
        });
        const startResult = await iniciarMyZap(dirPath, {
            onProgress: reportProgress
        });
        if (startResult?.status === 'error') {
            return startResult;
        }

        reportProgress('MyZap local iniciado. Finalizando ajustes...', 'start_confirmed', {
            percent: 95,
            dirPath
        });
        return {
            status: 'success',
            message: 'MyZap instalado, configurado e iniciado com sucesso!'
        };
    } catch (err) {
        transition('error', { message: err?.message || String(err), phase: 'clone_install' });
        logError('Erro critico no processo de instalacao', { metadata: { error: err } });
        return { status: 'error', message: `Erro: ${err.message}` };
    }
}

module.exports = clonarRepositorio;
