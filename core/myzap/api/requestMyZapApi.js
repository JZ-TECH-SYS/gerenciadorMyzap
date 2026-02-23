const Store = require('electron-store');
const { debug, warn } = require('../myzapLogger');

const store = new Store();
const DEFAULT_BASE_URLS = ['http://127.0.0.1:5555/', 'http://localhost:5555/'];

function normalizeBaseUrl(url) {
    const value = String(url || '').trim();
    if (!value) return '';
    return value.endsWith('/') ? value : `${value}/`;
}

function uniqueUrls(urls = []) {
    const output = [];
    const seen = new Set();
    for (const raw of urls) {
        const normalized = normalizeBaseUrl(raw);
        if (!normalized) continue;
        const key = normalized.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        output.push(normalized);
    }
    return output;
}

function getMyZapApiBaseUrls() {
    const configured = normalizeBaseUrl(
        store.get('myzap_localApiUrl')
            || store.get('myzap_apiUrlLocal')
            || ''
    );

    return uniqueUrls([configured, ...DEFAULT_BASE_URLS]);
}

function readSessionCredentials(input = {}) {
    const token = String(input.token || input.apitoken || store.get('myzap_apiToken') || '').trim();
    const sessionKey = String(input.sessionKey || input.sessionkey || store.get('myzap_sessionKey') || '').trim();
    const sessionNameRaw = input.sessionName || input.session_name || store.get('myzap_sessionName') || sessionKey;
    const sessionName = String(sessionNameRaw || sessionKey).trim();

    return {
        token,
        sessionKey,
        sessionName
    };
}

async function parseHttpResponse(res) {
    const contentType = String(res?.headers?.get('content-type') || '').toLowerCase();

    if (contentType.includes('application/json')) {
        return res.json().catch(() => ({}));
    }

    const text = await res.text().catch(() => '');
    if (!text) return {};

    try {
        return JSON.parse(text);
    } catch (_error) {
        return { raw: text };
    }
}

async function requestMyZapApi(endpoint, options = {}) {
    const {
        method = 'POST',
        body,
        headers = {},
        timeoutMs = 8000,
        credentials = {}
    } = options;

    const { token, sessionKey, sessionName } = readSessionCredentials(credentials);
    if (!token) {
        return {
            ok: false,
            status: 0,
            data: null,
            error: 'MISSING_APITOKEN'
        };
    }

    if (!sessionKey) {
        return {
            ok: false,
            status: 0,
            data: null,
            error: 'MISSING_SESSIONKEY'
        };
    }

    const endpointPath = String(endpoint || '').replace(/^\/+/, '');
    const baseUrls = getMyZapApiBaseUrls();

    const payload = (body === undefined)
        ? {
            session: sessionName,
            sessionkey: sessionKey,
            session_name: sessionName
        }
        : body;

    let lastError = null;

    for (const baseUrl of baseUrls) {
        const url = `${baseUrl}${endpointPath}`;
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), timeoutMs);

        try {
            debug('MyZap API request iniciada', {
                metadata: {
                    area: 'requestMyZapApi',
                    endpoint: endpointPath,
                    method,
                    baseUrl
                }
            });

            const response = await fetch(url, {
                method,
                headers: {
                    'Content-Type': 'application/json',
                    apitoken: token,
                    sessionkey: sessionKey,
                    sessionname: sessionName,
                    ...headers
                },
                body: String(method).toUpperCase() === 'GET'
                    ? undefined
                    : JSON.stringify(payload),
                signal: abort.signal
            });

            const data = await parseHttpResponse(response);
            clearTimeout(timer);

            return {
                ok: response.ok,
                status: response.status,
                data,
                error: response.ok ? null : `HTTP_${response.status}`,
                baseUrl,
                endpoint: endpointPath
            };
        } catch (err) {
            clearTimeout(timer);
            lastError = err;
            warn('Falha na chamada da API local do MyZap', {
                metadata: {
                    area: 'requestMyZapApi',
                    endpoint: endpointPath,
                    method,
                    baseUrl,
                    error: err?.message || String(err)
                }
            });
        }
    }

    return {
        ok: false,
        status: 0,
        data: null,
        error: lastError?.message || 'FETCH_FAILED',
        baseUrl: null,
        endpoint: endpointPath
    };
}

module.exports = {
    getMyZapApiBaseUrls,
    readSessionCredentials,
    requestMyZapApi
};
