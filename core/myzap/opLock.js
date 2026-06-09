/**
 * Mutex unico do ciclo de vida do MyZap local.
 *
 * Toda operacao que mexe no servico/instalacao (ensure, update, recovery do
 * supervisor, reset) deve rodar dentro de withLifecycleLock(). Isso elimina
 * as corridas em que dois fluxos instalavam/reiniciavam ao mesmo tempo.
 *
 * O lock tem heartbeat: qualquer progresso real (writeProgress, stdout do
 * pnpm install) chama touch(). Um lock so e considerado stale quando ficou
 * >5min sem heartbeat E >30min desde o acquire — assim um `pnpm install`
 * de 15min em maquina fraca nunca e morto no meio, mas um deadlock real
 * acaba destravando sozinho.
 */

const { info, warn } = require('./myzapLogger');

const STALE_HEARTBEAT_MS = 5 * 60 * 1000;
const STALE_ABSOLUTE_MS = 30 * 60 * 1000;

let holder = null;
let acquiredAt = 0;
let lastHeartbeatAt = 0;

function isStale() {
    if (!holder) return false;
    const now = Date.now();
    return (now - lastHeartbeatAt > STALE_HEARTBEAT_MS)
        && (now - acquiredAt > STALE_ABSOLUTE_MS);
}

function acquire(owner) {
    const name = String(owner || 'desconhecido');

    if (holder && !isStale()) {
        return { ok: false, holder };
    }

    if (holder) {
        warn('opLock: lock stale detectado, assumindo posse', {
            metadata: {
                area: 'opLock',
                staleHolder: holder,
                newHolder: name,
                heldForMs: Date.now() - acquiredAt,
                sinceHeartbeatMs: Date.now() - lastHeartbeatAt
            }
        });
    }

    holder = name;
    acquiredAt = Date.now();
    lastHeartbeatAt = acquiredAt;
    info('opLock: adquirido', { metadata: { area: 'opLock', holder: name } });
    return { ok: true, holder: name };
}

function release(owner) {
    if (holder !== String(owner || 'desconhecido')) {
        return false;
    }
    info('opLock: liberado', {
        metadata: { area: 'opLock', holder, heldForMs: Date.now() - acquiredAt }
    });
    holder = null;
    acquiredAt = 0;
    lastHeartbeatAt = 0;
    return true;
}

/** Heartbeat — chamado por qualquer sinal de progresso real. Barato (memoria). */
function touch() {
    if (holder) {
        lastHeartbeatAt = Date.now();
    }
}

function isHeld() {
    return Boolean(holder) && !isStale();
}

function getHolder() {
    return holder;
}

/**
 * Executa fn() segurando o lock. Se ja houver outra operacao em andamento,
 * NAO espera: devolve { status: 'busy' } para o chamador decidir o que fazer.
 */
async function withLifecycleLock(owner, fn) {
    const acq = acquire(owner);
    if (!acq.ok) {
        return {
            status: 'busy',
            holder: acq.holder,
            message: `Outra operacao do MyZap ja esta em andamento (${acq.holder}). Aguarde a conclusao.`
        };
    }

    try {
        return await fn();
    } finally {
        release(owner);
    }
}

module.exports = {
    acquire,
    release,
    touch,
    isHeld,
    getHolder,
    withLifecycleLock
};
