/**
 * Watcher de sincronizacao de tokens consumidos de IA.
 *
 * Cenario 6: quando IA esta ativa no modo local, faz polling periodico
 * ao MyZap local para obter tokens consumidos e envia para a API principal.
 *
 * Condicoes:
 *  - Apenas roda quando myzap_iaAtiva === true
 *  - Apenas roda quando myzap_rodarLocal === true (modo local)
 *  - Sincronizacao incremental (envia somente delta desde ultimo sync)
 *  - Falhas de rede nao causam perda de dados (mantém dados locais para proximo ciclo)
 */

const Store = require('electron-store');
const { info, warn, error, debug } = require('../myzap/myzapLogger');

const store = new Store();
const MYZAP_API_URL = 'http://localhost:5555/';
const LOOP_INTERVAL_MS = 60000; // 1 minuto
const FETCH_TIMEOUT_MS = 10000;
const LAST_SYNC_KEY = 'myzap_tokenSyncLastAt';
const LAST_SYNC_TOKENS_KEY = 'myzap_tokenSyncLastTotal';

let ativo = false;
let timer = null;
let ultimaExecucaoEm = null;
let ultimoErro = null;

function normalizeBaseUrl(url) {
    if (!url || typeof url !== 'string') return '';
    return url.endsWith('/') ? url : `${url}/`;
}

function isIaAtiva() {
    const iaAtiva = store.get('myzap_iaAtiva');
    if (iaAtiva === true || iaAtiva === 1) return true;
    const normalized = String(iaAtiva || '').trim().toLowerCase();
    return ['1', 'true', 'sim', 'yes', 'ativo', 'on'].includes(normalized);
}

function isModoLocal() {
    const modo = String(store.get('myzap_modoIntegracao') || 'local').trim().toLowerCase();
    return modo === 'local';
}

/**
 * Consulta MyZap local para obter total de tokens consumidos.
 * Tenta endpoint padrao de metricas/tokens da IA.
 */
async function buscarTokensConsumidosLocal() {
    const token = String(store.get('myzap_apiToken') || '').trim();
    const sessionKey = String(store.get('myzap_sessionKey') || '').trim();

    if (!token || !sessionKey) {
        return { ok: false, error: 'MISSING_CREDENTIALS' };
    }

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

    try {
        const res = await fetch(`${MYZAP_API_URL}admin/ia-manager/token-usage`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                apitoken: token,
                sessionkey: sessionKey
            },
            body: JSON.stringify({ session: sessionKey }),
            signal: ctrl.signal
        });

        clearTimeout(timeout);
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
            return { ok: false, error: `HTTP_${res.status}`, data };
        }

        // Espera-se que o MyZap retorne algo como { total_tokens: N, ... }
        const totalTokens = Number(data?.total_tokens ?? data?.tokens ?? data?.usage ?? 0);
        return {
            ok: true,
            totalTokens,
            data
        };
    } catch (err) {
        clearTimeout(timeout);
        return {
            ok: false,
            error: err?.name === 'AbortError' ? 'TIMEOUT' : (err?.message || String(err))
        };
    }
}

/**
 * Envia dados de consumo de tokens para a API principal da empresa.
 * Sincronizacao incremental: envia apenas o delta.
 */
async function enviarTokensParaApiPrincipal(tokensTotal, tokensDelta) {
    const clickApiUrl = normalizeBaseUrl(String(store.get('clickexpress_apiUrl') || '').trim());
    const clickToken = String(store.get('clickexpress_queueToken') || '').trim();
    const sessionKey = String(store.get('myzap_sessionKey') || '').trim();
    const idempresa = String(store.get('idempresa') || '').trim();

    if (!clickApiUrl || !clickToken || !sessionKey) {
        return { ok: false, error: 'CONFIG_INCOMPLETA' };
    }

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

    try {
        const payload = {
            sessionKey,
            idempresa,
            tokens_total: tokensTotal,
            tokens_delta: tokensDelta,
            data_sincronizacao: new Date().toISOString()
        };

        const res = await fetch(`${clickApiUrl}parametrizacao-myzap/tokens/sync`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${clickToken}`
            },
            body: JSON.stringify(payload),
            signal: ctrl.signal
        });

        clearTimeout(timeout);
        const data = await res.json().catch(() => ({}));

        if (!res.ok || data?.error) {
            return {
                ok: false,
                error: data?.error || `HTTP_${res.status}`
            };
        }

        return { ok: true, data };
    } catch (err) {
        clearTimeout(timeout);
        return {
            ok: false,
            error: err?.name === 'AbortError' ? 'TIMEOUT' : (err?.message || String(err))
        };
    }
}

async function processarUmaRodada() {
    // Verificar condicoes: IA ativa + modo local
    if (!isIaAtiva()) {
        debug('[TokenSync] IA nao esta ativa, pulando ciclo');
        return;
    }

    if (!isModoLocal()) {
        debug('[TokenSync] Modo nao e local, pulando ciclo');
        return;
    }

    try {
        // 1. Buscar tokens consumidos no MyZap local
        const resultado = await buscarTokensConsumidosLocal();

        if (!resultado.ok) {
            // Nao perder dados: mantemos o ultimo valor local para proximo ciclo
            debug('[TokenSync] Falha ao buscar tokens locais, tentando no proximo ciclo', {
                metadata: { error: resultado.error }
            });
            return;
        }

        const tokensAtual = resultado.totalTokens;
        const tokensAnterior = Number(store.get(LAST_SYNC_TOKENS_KEY) || 0);
        const delta = tokensAtual - tokensAnterior;

        // Sem delta = nada novo para sincronizar
        if (delta <= 0) {
            debug('[TokenSync] Sem tokens novos para sincronizar', {
                metadata: { tokensAtual, tokensAnterior, delta }
            });
            return;
        }

        // 2. Enviar delta para API principal
        const envio = await enviarTokensParaApiPrincipal(tokensAtual, delta);

        if (envio.ok) {
            // Atualizar referencia de ultimo sync bem-sucedido
            store.set(LAST_SYNC_TOKENS_KEY, tokensAtual);
            store.set(LAST_SYNC_KEY, Date.now());

            info('[TokenSync] Tokens sincronizados com sucesso', {
                metadata: {
                    area: 'tokenSyncWatcher',
                    tokensAtual,
                    delta,
                    tokensAnterior
                }
            });
        } else {
            // Falha de rede: NAO atualizar referencia = proximo ciclo reenvia o delta
            warn('[TokenSync] Falha ao enviar tokens para API principal (dados mantidos para proximo ciclo)', {
                metadata: {
                    area: 'tokenSyncWatcher',
                    error: envio.error,
                    tokensAtual,
                    delta
                }
            });
        }

        ultimoErro = envio.ok ? null : envio.error;
    } catch (err) {
        ultimoErro = err?.message || String(err);
        error('[TokenSync] Erro inesperado no ciclo de sync de tokens', {
            metadata: { area: 'tokenSyncWatcher', error: err }
        });
    } finally {
        ultimaExecucaoEm = new Date().toISOString();
    }
}

function startTokenSyncWatcher() {
    if (ativo) {
        return { status: 'success', message: 'Watcher de sync de tokens ja esta em execucao.' };
    }

    // Pre-condicao: IA ativa + modo local
    if (!isIaAtiva() || !isModoLocal()) {
        debug('[TokenSync] Condicoes nao atendidas para iniciar (IA ativa + modo local)', {
            metadata: { iaAtiva: isIaAtiva(), modoLocal: isModoLocal() }
        });
        return {
            status: 'skipped',
            message: 'Watcher de tokens nao iniciado: IA inativa ou modo nao-local.'
        };
    }

    ativo = true;
    ultimoErro = null;

    info('[TokenSync] Iniciando watcher de sincronizacao de tokens de IA', {
        metadata: { area: 'tokenSyncWatcher', loopMs: LOOP_INTERVAL_MS }
    });

    timer = setInterval(() => {
        processarUmaRodada().catch((err) => {
            error('[TokenSync] Erro inesperado no loop do watcher de tokens', {
                metadata: { area: 'tokenSyncWatcher', error: err }
            });
        });
    }, LOOP_INTERVAL_MS);

    // Executa rodada imediata
    processarUmaRodada().catch((err) => {
        error('[TokenSync] Erro na primeira rodada de sync de tokens', {
            metadata: { area: 'tokenSyncWatcher', error: err }
        });
    });

    return { status: 'success', message: 'Watcher de sync de tokens iniciado com sucesso.' };
}

function stopTokenSyncWatcher() {
    if (!ativo && !timer) {
        return { status: 'success', message: 'Watcher de sync de tokens ja estava parado.' };
    }

    if (timer) {
        clearInterval(timer);
        timer = null;
    }

    ativo = false;

    info('[TokenSync] Watcher de sincronizacao de tokens parado', {
        metadata: { area: 'tokenSyncWatcher' }
    });

    return { status: 'success', message: 'Watcher de sync de tokens parado com sucesso.' };
}

function getTokenSyncWatcherStatus() {
    return {
        ativo,
        iaAtiva: isIaAtiva(),
        modoLocal: isModoLocal(),
        ultimaExecucaoEm,
        ultimoErro,
        loopIntervalMs: LOOP_INTERVAL_MS,
        ultimoTotalSincronizado: Number(store.get(LAST_SYNC_TOKENS_KEY) || 0),
        ultimoSyncAt: Number(store.get(LAST_SYNC_KEY) || 0)
    };
}

module.exports = {
    startTokenSyncWatcher,
    stopTokenSyncWatcher,
    getTokenSyncWatcherStatus
};
