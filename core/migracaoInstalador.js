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
const Store = require('electron-store');
const { info, warn, error: logError } = require('./myzap/myzapLogger');
const { baixarArquivoComRetry } = require('./myzap/repositoryArchive');

const store = new Store();
const RELEASES_LATEST_API = 'https://api.github.com/repos/JZ-TECH-SYS/gerenciadorMyzap/releases/latest';
const FETCH_TIMEOUT_MS = 10000;
const OFERTA_COOLDOWN_KEY = 'myzap_migracaoOfertaAt';
const OFERTA_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function isRunningFromProgramFiles() {
    return process.platform === 'win32'
        && /\\Program Files( \(x86\))?\\/i.test(String(process.execPath || ''));
}

function getPerUserExePath() {
    const localAppData = process.env.LOCALAPPDATA
        || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'Programs', 'gerenciador-myzap', 'gerenciador-myzap.exe');
}

function isPerUserInstalled() {
    try {
        return fs.existsSync(getPerUserExePath());
    } catch (_e) {
        return false;
    }
}

/**
 * Casca antiga: se este processo roda de Program Files MAS a instalacao nova
 * por usuario JA existe, a migracao ja aconteceu — este exe so foi aberto por
 * um atalho/auto-launch antigo. Em vez de incomodar com dialogo (era o loop
 * de ofertas), redireciona para o app novo e fecha, invisivel para o cliente.
 *
 * @returns {boolean} true se redirecionou (o chamador deve abortar o boot)
 */
function redirectToPerUserIfInstalled({ app }) {
    if (!app?.isPackaged || !isRunningFromProgramFiles() || !isPerUserInstalled()) {
        return false;
    }

    const novoExe = getPerUserExePath();
    info('migracaoInstalador: instalacao por usuario ja existe — redirecionando e fechando a casca antiga', {
        metadata: { area: 'migracaoInstalador', de: process.execPath, para: novoExe }
    });

    try {
        // libera o single-instance lock ANTES de abrir o novo, senao o novo
        // morreria no proprio requestSingleInstanceLock
        if (typeof app.releaseSingleInstanceLock === 'function') {
            app.releaseSingleInstanceLock();
        }
        const child = spawn(novoExe, [], { detached: true, stdio: 'ignore' });
        child.on('error', (err) => {
            warn('migracaoInstalador: falha ao abrir o app novo no redirecionamento', {
                metadata: { area: 'migracaoInstalador', error: err?.message || String(err) }
            });
        });
        child.unref();
    } catch (err) {
        warn('migracaoInstalador: redirecionamento falhou, seguindo boot normal', {
            metadata: { area: 'migracaoInstalador', error: err?.message || String(err) }
        });
        return false;
    }

    setTimeout(() => app.exit(0), 800);
    return true;
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

    // Migracao ja concluida? So redireciona (sem dialogo).
    if (isPerUserInstalled()) {
        redirectToPerUserIfInstalled({ app });
        return { status: 'skipped', reason: 'per_user_ja_instalado' };
    }

    // Cooldown: no maximo 1 tentativa de oferta a cada 24h — escolheu "Mais
    // tarde" (ou falhou rede/download), nao enche o saco de novo no mesmo dia.
    const ultimaOferta = Number(store.get(OFERTA_COOLDOWN_KEY) || 0);
    if (Date.now() - ultimaOferta < OFERTA_COOLDOWN_MS) {
        return { status: 'skipped', reason: 'cooldown' };
    }
    store.set(OFERTA_COOLDOWN_KEY, Date.now());

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
        let spawnFalhou = false;
        child.on('error', (err) => {
            spawnFalhou = true;
            logError('migracaoInstalador: o instalador nao pode ser executado (antivirus/bloqueio?)', {
                metadata: { area: 'migracaoInstalador', error: err?.message || String(err) }
            });
            toast?.('O instalador foi bloqueado pelo sistema. Baixe o Setup manualmente do GitHub.');
        });
        child.unref();

        setTimeout(() => {
            if (!spawnFalhou) {
                app.quit();
            }
        }, 1500);
        return { status: 'success' };
    } catch (err) {
        logError('migracaoInstalador: falha ao baixar/executar o setup', {
            metadata: { area: 'migracaoInstalador', error: err?.message || String(err) }
        });
        toast?.('Nao foi possivel baixar o instalador agora. Tentaremos de novo no proximo inicio.');
        return { status: 'error', message: err?.message || String(err) };
    }
}

module.exports = {
    offerPerUserMigration,
    redirectToPerUserIfInstalled,
    isRunningFromProgramFiles,
    isPerUserInstalled
};
