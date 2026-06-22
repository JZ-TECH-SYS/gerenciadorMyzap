function isObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

function isContainer(value) {
    return Boolean(value) && typeof value === 'object';
}

function normalizeText(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim();
}

function listCandidates(payload) {
    const queue = [];
    const visited = new Set();

    function pushCandidate(value) {
        if (!isContainer(value)) return;
        if (visited.has(value)) return;
        visited.add(value);
        queue.push(value);
    }

    pushCandidate(payload);

    for (let idx = 0; idx < queue.length; idx += 1) {
        const current = queue[idx];

        if (Array.isArray(current)) {
            current.forEach(pushCandidate);
            continue;
        }

        Object.values(current).forEach((nested) => {
            if (Array.isArray(nested)) {
                nested.forEach(pushCandidate);
                return;
            }
            pushCandidate(nested);
        });
    }

    return queue;
}

function readPath(obj, path) {
    const segments = String(path || '').split('.').filter(Boolean);
    let current = obj;

    for (const segment of segments) {
        if (!isContainer(current) && !Array.isArray(current)) return undefined;
        current = current[segment];
    }

    return current;
}

function pickFirst(candidates, keys = []) {
    for (const key of keys) {
        for (const candidate of candidates) {
            if (!isObject(candidate)) continue;

            const direct = readPath(candidate, key);
            if (direct !== undefined && direct !== null && direct !== '') {
                return direct;
            }

            const loweredKey = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
            const matchedEntry = Object.entries(candidate).find(([entryKey, entryValue]) => {
                if (entryValue === undefined || entryValue === null || entryValue === '') {
                    return false;
                }
                const normalizedEntry = String(entryKey).toLowerCase().replace(/[^a-z0-9]/g, '');
                return normalizedEntry === loweredKey;
            });

            if (matchedEntry) {
                return matchedEntry[1];
            }
        }
    }

    return undefined;
}

function normalizeQr(rawValue) {
    if (rawValue === undefined || rawValue === null || rawValue === '') return '';

    let value = rawValue;
    if (isObject(value)) {
        value = value.base64
            || value.qrCode
            || value.qrcode
            || value.qr
            || value.image
            || value.data
            || '';
    }

    if (Array.isArray(value)) {
        value = value.find((item) => normalizeText(item));
    }

    const text = normalizeText(value);
    if (!text) return '';

    if (/^data:image\//i.test(text)) {
        return text;
    }

    if (/^https?:\/\//i.test(text)) {
        return text;
    }

    if (/^\//.test(text)) {
        return text;
    }

    const compact = text.replace(/\s+/g, '');
    if (/^[a-z0-9+/=]+$/i.test(compact) && compact.length > 100) {
        return `data:image/png;base64,${compact}`;
    }

    return text;
}

function hasKeyword(value, keywords = []) {
    const normalized = normalizeText(value).toLowerCase();
    if (!normalized) return false;
    return keywords.some((keyword) => normalized.includes(String(keyword).toLowerCase()));
}

/**
 * Match por PALAVRA INTEIRA (\b): evita o falso positivo classico em que o
 * estado transitorio "OPENING" (carregando, SEM login) casava com a keyword
 * "open" por substring e o painel mostrava "Conectado" sem QR lido.
 */
function hasWholeWord(value, words = []) {
    const normalized = normalizeText(value).toLowerCase();
    if (!normalized) return false;
    return words.some((word) => new RegExp(`\\b${word}\\b`, 'i').test(normalized));
}

function emptyParsed(rawPayload) {
    return {
        raw: rawPayload,
        status: '',
        state: '',
        realStatus: '',
        message: '',
        qrCode: '',
        isConnected: false,
        isQrWaiting: false,
        isInitializing: false,
        isNotFound: false,
        hasData: false
    };
}

function parseSessionPayload(payload) {
    const isArrayPayload = Array.isArray(payload);
    const isObjectPayload = isObject(payload);
    const isStringPayload = typeof payload === 'string';

    if (!isArrayPayload && !isObjectPayload && !isStringPayload) {
        return emptyParsed(payload);
    }

    const normalizedPayload = isStringPayload ? { message: payload } : payload;
    const candidates = listCandidates(normalizedPayload);
    if (candidates.length === 0) {
        return emptyParsed(payload);
    }

    const status = normalizeText(pickFirst(candidates, ['status', 'dbStatus', 'sessionStatus', 'connectionStatus']));
    const state = normalizeText(pickFirst(candidates, ['state', 'dbState', 'sessionState']));
    const realStatus = normalizeText(pickFirst(candidates, ['realStatus', 'real_status', 'statusReal', 'status_realtime']));
    const message = normalizeText(pickFirst(candidates, ['message', 'msg', 'detail', 'descricao']));

    const qrRaw = pickFirst(candidates, [
        'qrCode',
        'qrcode',
        'qr',
        'qr_base64',
        'qrBase64',
        'qr_code',
        'image',
        'base64',
        'data.qrCode',
        'result.qrCode',
        'response.qrCode'
    ]);

    const qrCode = normalizeQr(qrRaw);
    const joint = [status, state, realStatus, message].join(' ').toLowerCase();

    const isConnected = hasWholeWord(joint, [
        'connected',
        'open',
        'authenticated',
        'islogged',
        'inchat',
        'online',
        'ativo'
    ]);

    const isNotFound = hasKeyword(joint, [
        'not found',
        'not_found',
        'session not found',
        'sessao nao iniciada',
        'sessao nao encontrada',
        'nao iniciada',
        'nao encontrado'
    ]);

    const isQrWaiting = Boolean(qrCode) || hasKeyword(joint, [
        'qrcode',
        'qr code',
        'qr_code',
        'qrcodewaiting',
        'waiting qr',
        'awaiting qr',
        'aguardando qr'
    ]);

    // Estado TRANSITORIO de subida da sessao (Chrome/Puppeteer carregando). NAO e
    // "nao existe" nem "desconectado": o QR vem em seguida (dezenas de segundos).
    // Distingui-lo evita o delete prematuro que apagava a sessao no meio da
    // inicializacao (o MyZap respondia 404/INITIALIZING enquanto o client ainda
    // nao estava em memoria, mesmo ja tendo gerado o QR).
    const isInitializing = !isConnected && !qrCode && !isQrWaiting && hasKeyword(joint, [
        'initializing',
        'inicializando',
        'starting',
        'startup',
        'opening',
        'launching',
        'loading',
        'iniciando',
        'carregando'
    ]);

    const hasData = isArrayPayload ? payload.length > 0 : true;

    return {
        raw: payload,
        status,
        state,
        realStatus,
        message,
        qrCode,
        isConnected,
        isQrWaiting,
        isInitializing,
        isNotFound,
        hasData
    };
}

function scoreState(parsed) {
    if (!parsed || !parsed.hasData) return 0;
    if (parsed.isConnected) return 6;
    if (parsed.isQrWaiting && parsed.qrCode) return 5;
    if (parsed.isQrWaiting) return 4;
    if (parsed.isInitializing) return 3;
    if (parsed.isNotFound) return 2;
    return 1;
}

function mergeSessionPayloads(primaryParsed, secondaryParsed) {
    const first = scoreState(primaryParsed) >= scoreState(secondaryParsed)
        ? primaryParsed
        : secondaryParsed;
    const second = first === primaryParsed ? secondaryParsed : primaryParsed;

    const qrCode = first?.qrCode || second?.qrCode || '';
    const isConnected = Boolean(first?.isConnected || second?.isConnected);
    const isQrWaiting = Boolean(first?.isQrWaiting || second?.isQrWaiting || qrCode);
    const isInitializing = !isConnected && !isQrWaiting
        && Boolean(first?.isInitializing || second?.isInitializing);
    // not_found exige que AMBAS as fontes concordem; e qualquer sinal de "subindo"
    // tem precedencia sobre "nao existe" (durante o boot o status oscila 404<->INITIALIZING).
    const isNotFound = !isInitializing && Boolean(first?.isNotFound && second?.isNotFound);

    let sessionStatus = 'disconnected';
    if (isConnected) {
        sessionStatus = 'connected';
    } else if (isQrWaiting) {
        sessionStatus = 'waiting_qr';
    } else if (isInitializing) {
        sessionStatus = 'initializing';
    } else if (isNotFound) {
        sessionStatus = 'not_found';
    }

    const message = first?.message || second?.message || '';

    return {
        sessionStatus,
        isConnected,
        isQrWaiting,
        isInitializing,
        isNotFound,
        qrCode,
        message,
        verify: primaryParsed || null,
        connection: secondaryParsed || null
    };
}

module.exports = {
    parseSessionPayload,
    mergeSessionPayloads
};
