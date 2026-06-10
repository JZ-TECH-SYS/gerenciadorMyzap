/**
 * Supervisor (watchdog) do MyZap local.
 *
 * Depois que o MyZap sobe, NINGUEM monitorava o servico: travou = ficou
 * travado ate alguem reclamar. Este modulo fecha esse buraco:
 *
 *  - Health-check a cada 15s via GET /health do MyZap (fallback: porta 5555).
 *  - 3 falhas seguidas (~45s) => escada de recuperacao automatica:
 *      degrau 1: restart (mata arvore + porta livre + start)
 *      degrau 2: kill agressivo pela porta + start
 *      degrau 3: reinstalacao preservando dados (.env, database/, instances/)
 *    A sessao do WhatsApp reconecta sozinha: o MyZap chama startAllSessions()
 *    no boot a partir de database/ + instances/ preservados.
 *  - Circuit breaker: max 3 recuperacoes em 30min; estourou, pausa por 30min
 *    e notifica (evita loop infinito de restart em maquina com problema
 *    estrutural — antivirus matando o node, disco cheio etc.).
 *
 * Toda recuperacao roda dentro do opLock — nunca por cima de instalacao,
 * update ou reset em andamento.
 */

const Store = require('electron-store');
const { info, warn, error: logError } = require('./myzapLogger');
const {
    isPortInUse,
    killProcessesOnPort,
    waitForPortFree
} = require('./processUtils');
const { iniciarMyZap, stopMyZapAndFreePort, isMyZapInstallComplete } = require('./iniciarMyZap');
const {
    transition,
    forceTransition,
    getState,
    isSetupInProgress
} = require('./stateMachine');
const {
    resolveMyZapDirectory,
    isValidInstalledMyZapDirectory
} = require('./autoConfig');
const opLock = require('./opLock');

const store = new Store();

const HEALTH_INTERVAL_MS = 15 * 1000;
const HEALTH_TIMEOUT_MS = 5 * 1000;
const FAILS_TO_RECOVER = 3;
const POST_START_CONFIRM_MS = 60 * 1000;
const HEALTHY_STREAK_TO_RESET_STEP = 10;
const BREAKER_MAX_RECOVERIES = 3;
const BREAKER_WINDOW_MS = 30 * 60 * 1000;
const BREAKER_COOLDOWN_MS = 30 * 60 * 1000;
const PORTA = 5555;

let timer = null;
let tickRunning = false;
let failCount = 0;
let healthyStreak = 0;
let recoveryStep = 0; // degrau inicial da proxima recuperacao (0..2)
let recoveryHistory = []; // timestamps das recuperacoes na janela do breaker
let breakerState = 'closed'; // closed | open | half_open
let breakerOpenedAt = 0;
let lastHealth = null;
let lastRecovery = null;
let onNotify = () => {};

function wait(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function notify(message) {
    try {
        onNotify(message);
    } catch (_e) { /* melhor esforco */ }
}

function shouldSupervise() {
    const apiUrl = String(store.get('apiUrl') || '').trim();
    const apiToken = String(store.get('apiToken') || '').trim();
    const idempresa = String(store.get('idempresa') || '').trim();
    if (!apiUrl || !apiToken || !idempresa) return false;
    if (store.get('myzap_userRemovedLocal') === true) return false;

    const modo = String(store.get('myzap_modoIntegracao') || 'local').trim().toLowerCase() || 'local';
    return modo === 'local';
}

/**
 * Consulta a saude do MyZap local.
 * @returns {Promise<{ state: 'healthy'|'degraded'|'down', via?: string, detail?: string }>}
 */
async function checkHealth() {
    const baseUrls = ['http://127.0.0.1:5555/', 'http://localhost:5555/'];

    for (const baseUrl of baseUrls) {
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
        try {
            const res = await fetch(`${baseUrl}health`, { method: 'GET', signal: ctrl.signal });
            clearTimeout(timeout);

            // 404 = MyZap antigo sem /health; o Express respondeu = servico vivo.
            if (res.status === 404) {
                return { state: 'healthy', via: baseUrl, detail: 'legacy_sem_health' };
            }

            if (res.ok) {
                const body = await res.json().catch(() => ({}));
                if (body && body.db === 'down') {
                    warn('Supervisor: MyZap respondendo mas banco local indisponivel', {
                        metadata: { area: 'supervisor', dbError: body.db_error || null }
                    });
                }
                return { state: 'healthy', via: baseUrl };
            }

            // 5xx: o processo esta de pe mas doente
            return { state: 'degraded', via: baseUrl, detail: `http_${res.status}` };
        } catch (_err) {
            clearTimeout(timeout);
            // tenta proxima URL
        }
    }

    const portaAberta = await isPortInUse(PORTA);
    if (portaAberta) {
        // Porta presa mas HTTP mudo = processo zumbi/travado
        return { state: 'degraded', detail: 'porta_aberta_http_mudo' };
    }

    return { state: 'down', detail: 'porta_fechada' };
}

async function confirmHealthy(timeoutMs = POST_START_CONFIRM_MS) {
    const inicio = Date.now();
    for (;;) {
        const health = await checkHealth();
        if (health.state === 'healthy') return true;
        if (Date.now() - inicio >= timeoutMs) return false;
        await wait(3000);
    }
}

async function startAndConfirm(dir) {
    const result = await iniciarMyZap(dir, {});
    if (!result || result.status !== 'success') {
        warn('Supervisor: start falhou no degrau de recuperacao', {
            metadata: { area: 'supervisor', result }
        });
        return false;
    }
    return confirmHealthy();
}

/**
 * Executa um degrau da escada. Retorna true se o MyZap voltou saudavel.
 */
async function executeStep(step, dir) {
    if (step === 0) {
        info('Supervisor: degrau 1 — restart do servico', { metadata: { area: 'supervisor', dir } });
        await stopMyZapAndFreePort({ timeoutMs: 10000 });
        return startAndConfirm(dir);
    }

    if (step === 1) {
        info('Supervisor: degrau 2 — kill agressivo pela porta', { metadata: { area: 'supervisor', dir } });
        await stopMyZapAndFreePort({ timeoutMs: 5000 });
        killProcessesOnPort(PORTA);
        const portFree = await waitForPortFree(PORTA, { timeoutMs: 15000 });
        if (!portFree) {
            logError('Supervisor: porta 5555 nao liberou nem com kill agressivo', {
                metadata: { area: 'supervisor' }
            });
            notify('Nao foi possivel liberar a porta 5555 — algum processo externo esta segurando ela.');
            return false;
        }
        return startAndConfirm(dir);
    }

    // degrau 3: reinstalacao preservando dados (sessao/banco/.env)
    info('Supervisor: degrau 3 — reinstalacao preservando dados', { metadata: { area: 'supervisor', dir } });
    try {
        // require tardio para evitar custo no boot; updateMyZap reusa o fluxo de F3
        // eslint-disable-next-line global-require
        const { reinstallPreservingData } = require('./updateMyZap');
        const result = await reinstallPreservingData();
        if (!result || result.status !== 'success') {
            warn('Supervisor: reinstalacao preservando dados falhou', {
                metadata: { area: 'supervisor', result }
            });
            return false;
        }
        return confirmHealthy();
    } catch (err) {
        logError('Supervisor: erro na reinstalacao preservando dados', {
            metadata: { area: 'supervisor', error: err?.message || String(err) }
        });
        return false;
    }
}

/**
 * Roda a escada de recuperacao a partir do degrau persistido.
 * @param {{ manual?: boolean }} options reparo manual ignora/zera o breaker
 */
async function recover(health, options = {}) {
    const manual = Boolean(options.manual);
    const now = Date.now();
    recoveryHistory = recoveryHistory.filter((t) => now - t < BREAKER_WINDOW_MS);

    if (manual) {
        // Reparo pedido pelo usuario: da chance total, zerando o breaker.
        breakerState = 'closed';
        recoveryHistory = [];
        failCount = 0;
    } else if (breakerState !== 'half_open' && recoveryHistory.length >= BREAKER_MAX_RECOVERIES) {
        breakerState = 'open';
        breakerOpenedAt = now;
        logError('Supervisor: circuit breaker ABERTO — MyZap nao esta se mantendo no ar', {
            metadata: { area: 'supervisor', recoveries: recoveryHistory.length, windowMs: BREAKER_WINDOW_MS }
        });
        notify('MyZap nao esta se mantendo no ar. Recuperacao automatica pausada por 30 minutos — use "Reparar MyZap agora" no menu da bandeja.');
        return { status: 'breaker_open' };
    }

    recoveryHistory.push(now);

    const result = await opLock.withLifecycleLock(manual ? 'reparo-manual' : 'supervisor', async () => {
        transition('recovering', {
            message: manual
                ? 'Reparando o MyZap a pedido do usuario...'
                : `Recuperando o MyZap automaticamente (motivo: ${health.detail || health.state})...`
        });
        if (!manual) {
            notify('MyZap parou de responder. Recuperando automaticamente...');
        }

        const resolution = resolveMyZapDirectory();
        const dir = resolution.dir;

        // Sem instalacao valida/completa nao ha o que "reiniciar": restart so
        // cuspiria MODULE_NOT_FOUND — vai direto a reinstalacao preservando dados.
        let startStep = manual ? 0 : recoveryStep;
        if (!isValidInstalledMyZapDirectory(dir) || !isMyZapInstallComplete(dir)) {
            info('Supervisor: instalacao local ausente/incompleta, indo direto a reinstalacao', {
                metadata: { area: 'supervisor', dir }
            });
            startStep = 2;
        }

        for (let step = startStep; step <= 2; step += 1) {
            const ok = await executeStep(step, dir);
            if (ok) {
                return { status: 'success', step };
            }
        }

        return { status: 'error' };
    });

    if (result?.status === 'busy') {
        info('Supervisor: recuperacao adiada, outra operacao segura o lock', {
            metadata: { area: 'supervisor', holder: result.holder }
        });
        recoveryHistory.pop(); // nao conta como tentativa no breaker
        return result;
    }

    lastRecovery = {
        at: now,
        motivo: manual ? 'reparo_manual' : (health.detail || health.state),
        resultado: result?.status || 'error',
        degrau: typeof result?.step === 'number' ? result.step + 1 : null
    };

    if (result?.status === 'success') {
        info('Supervisor: MyZap recuperado com sucesso', {
            metadata: { area: 'supervisor', degrau: result.step + 1, manual }
        });
        notify(manual
            ? 'Reparo concluido: MyZap esta no ar novamente.'
            : `MyZap recuperado automaticamente (degrau ${result.step + 1}).`);
        // Se o degrau 1 nao resolveu, a proxima recuperacao comeca do que funcionou.
        recoveryStep = result.step;
        healthyStreak = 0;
        if (breakerState === 'half_open') {
            breakerState = 'closed';
            recoveryHistory = [];
        }
        return result;
    }

    transition('error', {
        message: 'Recuperacao automatica do MyZap falhou em todos os degraus.',
        phase: 'supervisor_recover'
    });
    notify('Nao foi possivel recuperar o MyZap automaticamente. Abra o painel para diagnostico.');
    if (breakerState === 'half_open') {
        breakerState = 'open';
        breakerOpenedAt = Date.now();
    }
    return result || { status: 'error' };
}

/**
 * Reparo completo SOB DEMANDA (botao "Reparar MyZap agora" no tray/painel).
 * Roda a escada inteira na hora, ignorando breaker e contagem de falhas.
 * E a "solucao rapida" que o proprio cliente aciona quando algo enrosca.
 */
async function forceRepair() {
    info('Supervisor: reparo manual solicitado pelo usuario', {
        metadata: { area: 'supervisor' }
    });

    const health = await checkHealth();
    const result = await recover(health, { manual: true });

    if (result?.status === 'busy') {
        return {
            status: 'busy',
            message: `Outra operacao do MyZap esta em andamento (${result.holder}). Aguarde alguns instantes e tente de novo.`
        };
    }

    if (result?.status === 'success') {
        return {
            status: 'success',
            degrau: (result.step ?? 0) + 1,
            message: 'MyZap reparado e no ar. A fila retoma sozinha em instantes.'
        };
    }

    return {
        status: 'error',
        message: 'O reparo automatico nao conseguiu subir o MyZap. Verifique a internet/antivirus ou use o Reset geral no painel.'
    };
}

async function tick() {
    if (tickRunning) return;
    tickRunning = true;

    try {
        if (!shouldSupervise()) return;
        if (opLock.isHeld()) return; // instalacao/update/reset em andamento
        if (isSetupInProgress()) return;

        if (breakerState === 'open') {
            if (Date.now() - breakerOpenedAt >= BREAKER_COOLDOWN_MS) {
                breakerState = 'half_open';
                info('Supervisor: circuit breaker meio-aberto, proxima falha tenta recuperar de novo', {
                    metadata: { area: 'supervisor' }
                });
            } else {
                return;
            }
        }

        const health = await checkHealth();
        lastHealth = { ...health, at: Date.now() };

        if (health.state === 'healthy') {
            if (failCount > 0) {
                info('Supervisor: MyZap saudavel novamente', { metadata: { area: 'supervisor' } });
            }
            failCount = 0;
            healthyStreak += 1;
            if (healthyStreak >= HEALTHY_STREAK_TO_RESET_STEP && recoveryStep !== 0) {
                recoveryStep = 0;
            }
            if (breakerState === 'half_open') {
                breakerState = 'closed';
                recoveryHistory = [];
            }
            // Reconciliar a state machine com a realidade (ex.: 'error' antigo)
            if (getState() !== 'running' && !isSetupInProgress() && !opLock.isHeld()) {
                forceTransition('running', {
                    message: 'MyZap ativo (confirmado pelo supervisor).',
                    porta: PORTA
                });
            }
            return;
        }

        healthyStreak = 0;
        failCount += 1;
        warn(`Supervisor: health ${health.state} (${failCount}/${FAILS_TO_RECOVER})`, {
            metadata: { area: 'supervisor', detail: health.detail || null }
        });

        if (failCount < FAILS_TO_RECOVER) return;

        failCount = 0;
        await recover(health);
    } catch (err) {
        logError('Supervisor: erro inesperado no ciclo', {
            metadata: { area: 'supervisor', error: err?.message || String(err) }
        });
    } finally {
        tickRunning = false;
    }
}

function startSupervisor(options = {}) {
    if (typeof options.onNotify === 'function') {
        onNotify = options.onNotify;
    }

    if (timer) return;

    info('Supervisor do MyZap iniciado', {
        metadata: {
            area: 'supervisor',
            intervaloMs: HEALTH_INTERVAL_MS,
            falhasParaRecuperar: FAILS_TO_RECOVER
        }
    });

    timer = setInterval(() => {
        tick().catch(() => {});
    }, HEALTH_INTERVAL_MS);
}

function stopSupervisor() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    failCount = 0;
    healthyStreak = 0;
    info('Supervisor do MyZap parado', { metadata: { area: 'supervisor' } });
}

function getSupervisorStatus() {
    return {
        ativo: Boolean(timer),
        saudavel: lastHealth?.state === 'healthy',
        ultimaVerificacao: lastHealth,
        falhasConsecutivas: failCount,
        proximoDegrau: recoveryStep + 1,
        ultimaRecuperacao: lastRecovery,
        breaker: {
            estado: breakerState,
            abertoDesde: breakerOpenedAt || null,
            recuperacoesNaJanela: recoveryHistory.length
        }
    };
}

module.exports = {
    startSupervisor,
    stopSupervisor,
    getSupervisorStatus,
    checkHealth,
    forceRepair
};
