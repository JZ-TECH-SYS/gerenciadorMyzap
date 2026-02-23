const baseLogger = require('../utils/logger');

function withMyZapChannel(options = {}) {
    return {
        ...options,
        channel: 'myzap'
    };
}

function info(message, options = {}) {
    baseLogger.info(message, withMyZapChannel(options));
}

function warn(message, options = {}) {
    baseLogger.warn(message, withMyZapChannel(options));
}

function error(message, options = {}) {
    baseLogger.error(message, withMyZapChannel(options));
}

function debug(message, options = {}) {
    baseLogger.debug(message, withMyZapChannel(options));
}

module.exports = {
    info,
    warn,
    error,
    debug
};
