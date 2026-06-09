/**
 * Automigracao do instalador perMachine (Program Files) -> perUser.
 *
 * O electron-updater mantem o ESCOPO da instalacao existente: quem esta na
 * versao antiga em Program Files continua la mesmo recebendo updates (e cada
 * update pede admin). A migracao real exige rodar o Setup novo — e o cliente
 * nao pode ter que "ir la baixar": o app baixa o Setup sozinho do GitHub
 * Releases, pergunta com UM dialogo e executa. O instalador (com o hook
 * build/installer.nsh) desinstala a versao antiga (1 clique de UAC), instala
 * por usuario e reabre o app. Sessao/config nao se perdem (ficam fora da
 * pasta de instalacao).
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { info, warn, error: logError } = require('./myzap/myzapLogger');
const { baixarArquivoComRetry } = require('./myzap/repositoryArchive');

const RELEASES_LATEST_API = 'https://api.github.com/repos/JZ-TECH-SYS/gerenciadorMyzap/releases/latest';
const FETCH_TIMEOUT_MS = 10000;

function isRunningFromProgramFiles() {
    return process.platform === 'win32'
        && /\\Program Files( \(x86\))?\\/i.test(String(process.execPath || ''));
}

async function buscarUrlDoSetupMaisRecente() {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(RELEASES_LATEST_API, {
            method: 'GET',
            headers: {
                Accept: 'application/vnd.github+json',
                'User-Agent': 'gerenciador-myzap'
            },
            signal: ctrl.signal
        });
        if (!res.ok) return null;

        const body = await res.json();
        const assets = Array.isArray(body?.assets) ? body.assets : [];
        const setup = assets.find((a) => /Setup.*\.exe$/i.test(String(a?.name || '')));
        return setup?.browser_download_url || null;
    } catch (err) {
        info('migracaoInstalador: falha ao consultar release mais recente', {
            metadata: { area: 'migracaoInstalador', error: err?.message || String(err) }
        });
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Oferece e executa a migracao para instalacao por usuario.
 * Chamar apos o boot (app empacotado, rodando de Program Files).
 *
 * @param {object} deps { app, dialog, toast }
 */
async function offerPerUserMigration({ app, dialog, toast }) {
    if (!app?.isPackaged || !isRunningFromProgramFiles()) {
        return { status: 'skipped', reason: 'nao_aplicavel' };
    }

    const setupUrl = await buscarUrlDoSetupMaisRecente();
    if (!setupUrl) {
        // Sem rede/sem release: orienta e tenta de novo no proximo boot
        toast?.('Atualizacao de instalador disponivel. Conecte a internet para migrar automaticamente.');
        return { status: 'skipped', reason: 'setup_url_indisponivel' };
    }

    const escolha = await dialog.showMessageBox({
        type: 'info',
        title: 'Atualizacao do Gerenciador MyZap',
        message: 'Vamos migrar sua instalacao para o novo formato (sem precisar de administrador nas proximas atualizacoes).',
        detail: 'O instalador sera baixado e aberto automaticamente. Basta confirmar — suas configuracoes e a sessao do WhatsApp sao preservadas.',
        buttons: ['Migrar agora (recomendado)', 'Mais tarde'],
        defaultId: 0,
        cancelId: 1
    });

    if (escolha.response !== 0) {
        info('migracaoInstalador: usuario adiou a migracao', {
            metadata: { area: 'migracaoInstalador' }
        });
        return { status: 'skipped', reason: 'adiado_pelo_usuario' };
    }

    try {
        toast?.('Baixando o instalador novo... o app vai reiniciar sozinho.');
        const destino = path.join(os.tmpdir(), 'gerenciador-myzap-setup-migracao.exe');
        try { fs.rmSync(destino, { force: true }); } catch (_e) { /* melhor esforco */ }

        await baixarArquivoComRetry(setupUrl, destino);

        info('migracaoInstalador: setup baixado, executando instalador', {
            metadata: { area: 'migracaoInstalador', destino }
        });

        // Modo assistido: o NSIS remove a instalacao antiga (UAC 1x), instala
        // por usuario e reabre o app ao concluir (runAfterFinish padrao).
        const child = spawn(destino, [], { detached: true, stdio: 'ignore' });
        child.unref();

        setTimeout(() => app.quit(), 1500);
        return { status: 'success' };
    } catch (err) {
        logError('migracaoInstalador: falha ao baixar/executar o setup', {
            metadata: { area: 'migracaoInstalador', error: err?.message || String(err) }
        });
        toast?.('Nao foi possivel baixar o instalador agora. Tentaremos de novo no proximo inicio.');
        return { status: 'error', message: err?.message || String(err) };
    }
}

module.exports = { offerPerUserMigration, isRunningFromProgramFiles };
