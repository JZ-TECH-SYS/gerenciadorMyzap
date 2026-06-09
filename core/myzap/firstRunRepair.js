/**
 * Saneamento automatico no PRIMEIRO boot de cada versao nova do app.
 *
 * Cenario real: o cliente estava com a versao antiga bugada (processo zumbi
 * segurando a porta 5555, progresso de instalacao travado, QR velho em cache)
 * e instalou/atualizou para a versao nova. Ele NAO pode ter que fazer nada na
 * mao: esta rotina roda antes do auto-start e deixa o terreno limpo.
 *
 * O que faz (com guardas — nunca mexe em maquina sem config/modo local):
 *   1. mata processos orfaos nas portas do MyZap (zumbis da versao anterior);
 *   2. espera a porta liberar DE VERDADE;
 *   3. limpa progresso de instalacao travado e cache de QR antigo;
 *   4. registra a versao para nao repetir.
 */

const Store = require('electron-store');
const { info, warn } = require('./myzapLogger');
const { killProcessesOnPort, waitForPortFree } = require('./processUtils');
const { clearProgress } = require('./progress');
const { clearCachedQr } = require('./api/getSessionSnapshot');

const store = new Store();
const LAST_RUN_VERSION_KEY = 'app_lastRunVersion';
const MYZAP_PORTS = [5555, 3333];

function isModoLocalComConfig() {
    const apiUrl = String(store.get('apiUrl') || '').trim();
    const apiToken = String(store.get('apiToken') || '').trim();
    const idempresa = String(store.get('idempresa') || '').trim();
    if (!apiUrl || !apiToken || !idempresa) return false;
    if (store.get('myzap_userRemovedLocal') === true) return false;
    const modo = String(store.get('myzap_modoIntegracao') || 'local').trim().toLowerCase() || 'local';
    return modo === 'local';
}

/**
 * @param {string} currentVersion app.getVersion()
 * @returns {Promise<{ executado: boolean, detalhes?: object }>}
 */
async function runPostUpdateRepairIfNeeded(currentVersion) {
    const versao = String(currentVersion || '').trim();
    const ultimaVersao = String(store.get(LAST_RUN_VERSION_KEY) || '').trim();

    if (!versao || ultimaVersao === versao) {
        return { executado: false };
    }

    info('firstRunRepair: primeira execucao desta versao — saneando ambiente', {
        metadata: { area: 'firstRunRepair', de: ultimaVersao || '(nenhuma)', para: versao }
    });

    const detalhes = { portas: [], progressoLimpo: false };

    try {
        // Estado herdado de instalacao/QR travados da versao anterior
        clearProgress();
        clearCachedQr();
        detalhes.progressoLimpo = true;

        // Zumbis da versao antiga segurando as portas (so em modo local com
        // config valida — nunca derruba servico alheio em maquina modo web)
        if (isModoLocalComConfig()) {
            for (const porta of MYZAP_PORTS) {
                const kill = killProcessesOnPort(porta);
                const liberou = await waitForPortFree(porta, { timeoutMs: 10000 });
                detalhes.portas.push({ porta, ...kill, liberou });
                if (kill.killed.length > 0) {
                    info('firstRunRepair: processos orfaos finalizados', {
                        metadata: { area: 'firstRunRepair', porta, killed: kill.killed, liberou }
                    });
                }
            }
        }
    } catch (err) {
        warn('firstRunRepair: falha parcial no saneamento (seguindo o boot)', {
            metadata: { area: 'firstRunRepair', error: err?.message || String(err) }
        });
    } finally {
        store.set(LAST_RUN_VERSION_KEY, versao);
    }

    info('firstRunRepair: saneamento concluido', {
        metadata: { area: 'firstRunRepair', detalhes }
    });

    return { executado: true, detalhes };
}

module.exports = { runPostUpdateRepairIfNeeded };
