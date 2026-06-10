/**
 * Checagem de atualizacao do MyZap local SEM Git.
 *
 * Compara o commit SHA da branch main (via API do GitHub) com o SHA gravado
 * na instalacao local. Divergiu => baixa o ZIP pinado naquele SHA e troca a
 * instalacao preservando dados (updateMyZap.js).
 *
 * Rate limit anonimo da API: 60 req/h — com check no boot + a cada 6h, sobra
 * folga enorme.
 */

const Store = require('electron-store');
const { info, warn } = require('./myzapLogger');
const { withLifecycleLock } = require('./opLock');
const { isLocalHttpServiceReachable } = require('./processUtils');

const store = new Store();

const INSTALLED_SHA_KEY = 'myzap_installedCommitSha';
const COMMIT_API_URL = 'https://api.github.com/repos/JZ-TECH-SYS/myzap/commits/main';
const FETCH_TIMEOUT_MS = 10000;

function getInstalledSha() {
    return String(store.get(INSTALLED_SHA_KEY) || '').trim();
}

function setInstalledSha(sha) {
    const value = String(sha || '').trim();
    if (value) {
        store.set(INSTALLED_SHA_KEY, value);
    }
}

/**
 * Busca o SHA atual da main no GitHub. Retorna null em falha (offline etc.).
 */
async function fetchRemoteMainSha() {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

    try {
        const res = await fetch(COMMIT_API_URL, {
            method: 'GET',
            headers: {
                Accept: 'application/vnd.github.sha',
                'User-Agent': 'gerenciador-myzap'
            },
            signal: ctrl.signal
        });

        if (!res.ok) {
            warn('updateChecker: API do GitHub respondeu com erro', {
                metadata: { area: 'updateChecker', status: res.status }
            });
            return null;
        }

        const sha = String(await res.text()).trim();
        return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
    } catch (err) {
        info('updateChecker: nao foi possivel consultar versao remota (offline?)', {
            metadata: { area: 'updateChecker', error: err?.message || String(err) }
        });
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Compara SHA remoto x instalado e atualiza se preciso.
 * @param {{ force?: boolean, onProgress?: Function }} options
 */
async function checkAndUpdateIfNeeded(options = {}) {
    const force = Boolean(options.force);

    const remoteSha = await fetchRemoteMainSha();
    if (!remoteSha) {
        return {
            status: force ? 'error' : 'skipped',
            reason: 'remote_sha_unavailable',
            message: 'Nao foi possivel consultar a versao mais recente do MyZap (sem rede?).'
        };
    }

    const installedSha = getInstalledSha();
    if (!force && installedSha && installedSha === remoteSha) {
        return {
            status: 'success',
            upToDate: true,
            sha: installedSha,
            message: 'MyZap ja esta na versao mais recente.'
        };
    }

    // Instalacao SEM SHA registrado (veio de versao antiga do gerenciador) e
    // FUNCIONANDO: adota o SHA remoto como baseline em vez de fazer cirurgia
    // numa instalacao saudavel. O proximo ciclo compara de verdade — e o
    // botao "Atualizar MyZap agora" (force) continua atualizando na hora.
    if (!force && !installedSha) {
        const saudavel = await isLocalHttpServiceReachable({ timeoutMs: 3000 });
        if (saudavel) {
            setInstalledSha(remoteSha);
            info('updateChecker: instalacao saudavel sem SHA registrado — baseline adotada', {
                metadata: { area: 'updateChecker', remoteSha }
            });
            return {
                status: 'success',
                upToDate: true,
                baselineAdopted: true,
                sha: remoteSha,
                message: 'Versao local registrada como baseline (sem atualizacao).'
            };
        }
    }

    info('updateChecker: atualizacao do MyZap necessaria', {
        metadata: {
            area: 'updateChecker',
            installedSha: installedSha || null,
            remoteSha,
            force
        }
    });

    return withLifecycleLock('update', async () => {
        // require tardio: updateMyZap puxa iniciarMyZap/clonarRepositorio etc.
        // eslint-disable-next-line global-require
        const { updateMyZapFromArchive } = require('./updateMyZap');
        return updateMyZapFromArchive(remoteSha, { onProgress: options.onProgress });
    });
}

module.exports = {
    INSTALLED_SHA_KEY,
    getInstalledSha,
    setInstalledSha,
    fetchRemoteMainSha,
    checkAndUpdateIfNeeded
};
