const baseLogger = require('../utils/logger');

// Wrapper do canal 'backend': usado nas chamadas ao DisparaZap
// (buscarPendentes / atualizarStatusFila), separando-as dos logs do MyZap local.
function withBackendChannel(options = {}) {
    return {
        ...options,
        channel: 'backend'
    };
}

function info(message, options = {}) {
    baseLogger.info(message, withBackendChannel(options));
}

function warn(message, options = {}) {
    baseLogger.warn(message, withBackendChannel(options));
}

function error(message, options = {}) {
    baseLogger.error(message, withBackendChannel(options));
}

function debug(message, options = {}) {
    baseLogger.debug(message, withBackendChannel(options));
}

module.exports = {
    info,
    warn,
    error,
    debug
};
