/**
 * Maquina de estados centralizada do modulo MyZap.
 *
 * Estados possiveis:
 *   idle, checking_config, installing_git, installing_node,
 *   cloning_repo, installing_dependencies, starting_service,
 *   running, error, resetting
 *
 * Todas as transicoes sao validadas contra um mapa de transicoes permitidas.
 * Listeners sao notificados a cada mudanca de estado (IPC push no main.js).
 */

const { info, warn, debug } = require('./myzapLogger');

const VALID_STATES = [
    'idle',
    'checking_config',
    'installing_git',
    'installing_node',
    'cloning_repo',
    'installing_dependencies',
    'starting_service',
    'running',
    'error',
    'resetting'
];

/**
 * Mapa de transicoes permitidas.
 * Chave = estado atual, valor = array de estados destino validos.
 */
const TRANSITIONS = {
    idle: ['checking_config', 'resetting'],
    checking_config: [
        'cloning_repo',
        'installing_git',
        'installing_node',
        'starting_service',
        'running',
        'error',
        'idle'
    ],
    installing_git: ['installing_node', 'cloning_repo', 'checking_config', 'error', 'resetting'],
    installing_node: ['cloning_repo', 'checking_config', 'error', 'resetting'],
    cloning_repo: ['installing_dependencies', 'error', 'resetting'],
    installing_dependencies: ['starting_service', 'error', 'resetting'],
    starting_service: ['running', 'error', 'resetting'],
    running: ['error', 'resetting', 'idle', 'checking_config'],
    error: ['idle', 'resetting', 'checking_config'],
    resetting: ['idle', 'error']
};

/** Labels amigaveis para cada estado (usados na UI) */
const STATE_LABELS = {
    idle: 'Ocioso',
    checking_config: 'Verificando configuracao...',
    installing_git: 'Instalando Git...',
    installing_node: 'Instalando Node.js...',
    cloning_repo: 'Clonando repositorio...',
    installing_dependencies: 'Instalando dependencias...',
    starting_service: 'Iniciando servico...',
    running: 'Em execucao',
    error: 'Erro',
    resetting: 'Resetando ambiente...'
};

/** Porcentagem estimada de progresso por estado */
const STATE_PROGRESS = {
    idle: 0,
    checking_config: 10,
    installing_git: 20,
    installing_node: 30,
    cloning_repo: 40,
    installing_dependencies: 60,
    starting_service: 80,
    running: 100,
    error: 0,
    resetting: 50
};

let currentState = 'idle';
let stateMetadata = {};
let lastError = null;
let stateChangedAt = Date.now();

/** @type {Array<function({ state: string, previous: string, metadata: object, label: string, progress: number, error: string|null, changedAt: number }): void>} */
const listeners = [];

/**
 * Retorna o estado atual.
 * @returns {string}
 */
function getState() {
    return currentState;
}

/**
 * Retorna snapshot completo do estado para envio via IPC.
 * @returns {object}
 */
function getStateSnapshot() {
    return {
        state: currentState,
        metadata: stateMetadata,
        label: STATE_LABELS[currentState] || currentState,
        progress: STATE_PROGRESS[currentState] ?? 0,
        error: lastError,
        changedAt: stateChangedAt
    };
}

/**
 * Verifica se uma transicao do estado atual para `newState` e valida.
 * @param {string} newState
 * @returns {boolean}
 */
function canTransition(newState) {
    if (!VALID_STATES.includes(newState)) return false;
    const allowed = TRANSITIONS[currentState];
    if (!allowed) return false;
    return allowed.includes(newState);
}

/**
 * Executa a transicao de estado.
 * @param {string} newState - Estado destino
 * @param {object} [metadata] - Dados adicionais (mensagem, dirPath etc.)
 * @returns {{ ok: boolean, previous: string, current: string, rejected?: string }}
 */
function transition(newState, metadata = {}) {
    if (!VALID_STATES.includes(newState)) {
        warn(`StateMachine: estado invalido "${newState}"`, {
            metadata: { area: 'stateMachine', current: currentState, attempted: newState }
        });
        return { ok: false, previous: currentState, current: currentState, rejected: newState };
    }

    // Permitir transicao para o mesmo estado (atualiza metadata)
    if (newState === currentState) {
        stateMetadata = { ...stateMetadata, ...metadata };
        stateChangedAt = Date.now();
        notifyListeners(currentState, currentState, metadata);
        return { ok: true, previous: currentState, current: currentState };
    }

    if (!canTransition(newState)) {
        warn(`StateMachine: transicao rejeitada ${currentState} -> ${newState}`, {
            metadata: { area: 'stateMachine', current: currentState, attempted: newState, metadata }
        });
        return { ok: false, previous: currentState, current: currentState, rejected: newState };
    }

    const previous = currentState;
    currentState = newState;
    stateMetadata = metadata;
    stateChangedAt = Date.now();

    if (newState === 'error') {
        lastError = metadata.message || metadata.error || 'Erro desconhecido';
    } else {
        lastError = null;
    }

    info(`StateMachine: ${previous} -> ${newState}`, {
        metadata: { area: 'stateMachine', previous, current: newState, metadata }
    });

    notifyListeners(newState, previous, metadata);

    return { ok: true, previous, current: newState };
}

/**
 * Forca a transicao ignorando validacao de mapa.
 * Deve ser usado somente em cenarios de recuperacao de emergencia.
 * @param {string} newState
 * @param {object} [metadata]
 */
function forceTransition(newState, metadata = {}) {
    if (!VALID_STATES.includes(newState)) return;

    const previous = currentState;
    currentState = newState;
    stateMetadata = metadata;
    stateChangedAt = Date.now();
    lastError = newState === 'error' ? (metadata.message || 'Erro desconhecido') : null;

    warn(`StateMachine: transicao forcada ${previous} -> ${newState}`, {
        metadata: { area: 'stateMachine', previous, current: newState, metadata }
    });

    notifyListeners(newState, previous, metadata);
}

/**
 * Reseta a maquina para `idle` incondicionalmente.
 */
function resetState() {
    forceTransition('idle', { reason: 'reset_manual' });
}

/**
 * Registra listener para mudancas de estado.
 * @param {function} callback - Recebe { state, previous, metadata, label, progress, error, changedAt }
 * @returns {function} Funcao para remover o listener
 */
function onStateChange(callback) {
    if (typeof callback !== 'function') return () => {};
    listeners.push(callback);
    return () => {
        const idx = listeners.indexOf(callback);
        if (idx !== -1) listeners.splice(idx, 1);
    };
}

/**
 * Remove todos os listeners.
 */
function removeAllListeners() {
    listeners.length = 0;
}

/* ── internal ────────────────────────────────────── */

function notifyListeners(state, previous, metadata) {
    const payload = {
        state,
        previous,
        metadata,
        label: STATE_LABELS[state] || state,
        progress: STATE_PROGRESS[state] ?? 0,
        error: lastError,
        changedAt: stateChangedAt
    };

    for (const cb of listeners) {
        try {
            cb(payload);
        } catch (err) {
            warn('StateMachine: erro ao notificar listener', {
                metadata: { area: 'stateMachine', error: err?.message || String(err) }
            });
        }
    }
}

/* ── helpers para uso nos modulos orquestradores ── */

/**
 * Verifica se o estado atual indica que uma operacao de setup esta em andamento.
 * @returns {boolean}
 */
function isSetupInProgress() {
    return [
        'checking_config',
        'installing_git',
        'installing_node',
        'cloning_repo',
        'installing_dependencies',
        'starting_service',
        'resetting'
    ].includes(currentState);
}

/**
 * Verifica se o MyZap esta rodando.
 * @returns {boolean}
 */
function isRunning() {
    return currentState === 'running';
}

module.exports = {
    VALID_STATES,
    STATE_LABELS,
    STATE_PROGRESS,
    getState,
    getStateSnapshot,
    canTransition,
    transition,
    forceTransition,
    resetState,
    onStateChange,
    removeAllListeners,
    isSetupInProgress,
    isRunning
};
