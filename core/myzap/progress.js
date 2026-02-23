const Store = require('electron-store');
const { info, warn, debug } = require('./myzapLogger');

const store = new Store();
const PROGRESS_KEY = 'myzap_progress';

function getCurrentProgress() {
    const value = store.get(PROGRESS_KEY);
    return (value && typeof value === 'object') ? value : {};
}

function writeProgress(payload = {}) {
    const current = getCurrentProgress();
    const now = Date.now();
    const merged = {
        ...current,
        ...payload,
        updated_at: now
    };

    if (!merged.started_at) {
        merged.started_at = now;
    }

    store.set(PROGRESS_KEY, merged);
    return merged;
}

function startProgress(message, phase = 'start', metadata = {}) {
    const value = writeProgress({
        active: true,
        state: 'running',
        phase,
        message,
        metadata,
        started_at: Date.now(),
        finished_at: null
    });
    info('MyZap progresso iniciado', { metadata: value });
    return value;
}

function stepProgress(message, phase = 'step', metadata = {}) {
    const value = writeProgress({
        active: true,
        state: 'running',
        phase,
        message,
        metadata,
        finished_at: null
    });
    debug('MyZap progresso atualizado', { metadata: value });
    return value;
}

function finishProgressSuccess(message, phase = 'done', metadata = {}) {
    const value = writeProgress({
        active: false,
        state: 'success',
        phase,
        message,
        metadata,
        finished_at: Date.now()
    });
    info('MyZap progresso concluido com sucesso', { metadata: value });
    return value;
}

function finishProgressError(message, phase = 'error', metadata = {}) {
    const value = writeProgress({
        active: false,
        state: 'error',
        phase,
        message,
        metadata,
        finished_at: Date.now()
    });
    warn('MyZap progresso finalizado com erro', { metadata: value });
    return value;
}

function clearProgress() {
    store.delete(PROGRESS_KEY);
}

module.exports = {
    PROGRESS_KEY,
    getCurrentProgress,
    startProgress,
    stepProgress,
    finishProgressSuccess,
    finishProgressError,
    clearProgress
};
