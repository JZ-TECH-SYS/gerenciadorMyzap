const os = require('os');
const fs = require('fs');
const path = require('path');
const Store = require('electron-store');
const { info, warn, debug } = require('./myzapLogger');
const {
    startProgress,
    stepProgress,
    finishProgressSuccess,
    finishProgressError
} = require('./progress');
const verificarDiretorio = require('./verificarDiretorio');
const clonarRepositorio = require('./clonarRepositorio');
const atualizarEnv = require('./atualizarEnv');
const updateIaConfig = require('./api/updateIaConfig');
const { transition, forceTransition, getState } = require('./stateMachine');
const {
    parseBooleanLike,
    buildBackendProfileKey,
    clearDerivedBackendState,
    extractCapabilityHintsFromFlatMap,
    getCapabilitySnapshot,
    getStoredCapabilityRemoteHints,
    refreshCapabilitySnapshotFromStore,
    setStoredCapabilityRemoteHints,
    sanitizeBackendApiUrl
} = require('./capabilities');

const store = new Store();
const REMOTE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const LAST_REMOTE_SYNC_KEY = 'myzap_lastRemoteConfigSyncAt';
const ENSURE_STALE_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_DEBUG_TEXT_LENGTH = 12000;
const MAX_DEBUG_ITEMS = 80;
let ensureInFlight = null;
let ensureInFlightStartedAt = 0;
let lastRemoteConfigDebug = {
    generatedAt: Date.now(),
    success: false,
    reason: 'not_requested',
    attempts: []
};

function cloneJsonSafe(value, fallback = null) {
    try {
        return JSON.parse(JSON.stringify(value));
    } catch (_e) {
        return fallback;
    }
}

function truncateText(value, maxLen = MAX_DEBUG_TEXT_LENGTH) {
    const str = String(value ?? '');
    if (str.length <= maxLen) return str;
    return `${str.slice(0, maxLen)} ...[truncated ${str.length - maxLen} chars]`;
}

function truncateDebugValue(value, depth = 0) {
    if (value === null || value === undefined) return value;
    if (depth >= 6) return '[max_depth]';

    if (typeof value === 'string') {
        return truncateText(value);
    }

    if (Array.isArray(value)) {
        const sliced = value.slice(0, MAX_DEBUG_ITEMS).map((item) => truncateDebugValue(item, depth + 1));
        if (value.length > MAX_DEBUG_ITEMS) {
            sliced.push(`[truncated_items:${value.length - MAX_DEBUG_ITEMS}]`);
        }
        return sliced;
    }

    if (typeof value === 'object') {
        const entries = Object.entries(value).slice(0, MAX_DEBUG_ITEMS);
        const out = {};
        entries.forEach(([key, val]) => {
            out[key] = truncateDebugValue(val, depth + 1);
        });
        const total = Object.keys(value).length;
        if (total > MAX_DEBUG_ITEMS) {
            out.__truncated_fields = total - MAX_DEBUG_ITEMS;
        }
        return out;
    }

    return value;
}

function setLastRemoteConfigDebug(snapshot) {
    const normalized = cloneJsonSafe(snapshot, null);
    if (normalized) {
        lastRemoteConfigDebug = normalized;
    }
}

function getAutoConfigDebugSnapshot() {
    return cloneJsonSafe(lastRemoteConfigDebug, {
        generatedAt: Date.now(),
        success: false,
        reason: 'snapshot_unavailable',
        attempts: []
    });
}

function normalizeBaseUrl(url) {
    if (!url || typeof url !== 'string') return '';
    return url.endsWith('/') ? url : `${url}/`;
}

function getDefaultMyZapDirectory() {
    const platform = os.platform();
    const home = os.homedir();

    if (platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
        return path.join(localAppData, 'gerenciador-myzap', 'myzap');
    }

    if (platform === 'darwin') {
        return path.join(home, 'Library', 'Application Support', 'gerenciador-myzap', 'myzap');
    }

    const xdgDataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
    return path.join(xdgDataHome, 'gerenciador-myzap', 'myzap');
}

function isValidInstalledMyZapDirectory(dirPath) {
    try {
        if (!dirPath || typeof dirPath !== 'string') return false;
        const normalized = path.normalize(String(dirPath).trim());
        if (!normalized || !fs.existsSync(normalized)) return false;
        return fs.existsSync(path.join(normalized, 'package.json'));
    } catch (_err) {
        return false;
    }
}

function resolveMyZapDirectory() {
    const defaultDir = getDefaultMyZapDirectory();
    const storedDirRaw = String(store.get('myzap_diretorio') || '').trim();

    if (!storedDirRaw) {
        return {
            dir: defaultDir,
            source: 'default_empty_store'
        };
    }

    const storedDir = path.normalize(storedDirRaw);
    const defaultNormalized = path.normalize(defaultDir);
    if (storedDir === defaultNormalized) {
        return {
            dir: defaultDir,
            source: 'default_saved'
        };
    }

    if (isValidInstalledMyZapDirectory(storedDir)) {
        return {
            dir: storedDir,
            source: 'stored_valid_installation'
        };
    }

    warn('MyZap diretorio salvo invalido. Aplicando diretorio padrao do sistema operacional.', {
        metadata: {
            area: 'autoConfig',
            storedDir,
            defaultDir
        }
    });

    return {
        dir: defaultDir,
        source: 'fallback_default_invalid_store'
    };
}

function putFlatEntry(map, key, value) {
    if (value === undefined || value === null) return;

    const normalizedKey = String(key || '')
        .replace(/[^a-zA-Z0-9]/g, '')
        .toLowerCase();

    if (!normalizedKey) return;

    if (typeof value === 'object') {
        return;
    }

    const normalizedValue = String(value).trim();
    if (!normalizedValue) return;

    if (!map.has(normalizedKey)) {
        map.set(normalizedKey, normalizedValue);
    }
}

function flattenObject(value, map = new Map()) {
    if (Array.isArray(value)) {
        value.forEach((item, idx) => flattenObject(item, map, idx));
        return map;
    }

    if (value && typeof value === 'object') {
        Object.entries(value).forEach(([key, val]) => {
            putFlatEntry(map, key, val);
            flattenObject(val, map);
        });
    }

    return map;
}

function pickFirst(map, keys = []) {
    for (const key of keys) {
        const normalizedKey = String(key || '')
            .replace(/[^a-zA-Z0-9]/g, '')
            .toLowerCase();

        const value = map.get(normalizedKey);
        if (value) {
            return value;
        }
    }

    return '';
}

function normalizeIntegrationMode(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return '';

    if (raw === '1') return 'web';
    if (raw === '2') return 'local';

    const localKeywords = ['fila', 'local', 'desktop', 'cliente', 'client', 'onpremise', 'on-premise', 'localhost'];
    const webKeywords = ['web', 'online', 'cloud', 'nuvem', 'hosted', 'remoto', 'remote'];

    if (localKeywords.includes(raw) || localKeywords.some((key) => raw.includes(key))) {
        return 'local';
    }

    if (webKeywords.includes(raw) || webKeywords.some((key) => raw.includes(key))) {
        return 'web';
    }

    return '';
}

function buildDefaultEnv({ sessionKey, myzapApiToken }) {
    return [
        '# Arquivo .env gerado automaticamente pelo Gerenciador MyZap',
        'NODE_ENV=production',
        'PORT=5555',
        '',
        `SESSION_NAME=${sessionKey}`,
        `SESSION_KEY=${sessionKey}`,
        `SESSIONKEY=${sessionKey}`,
        '',
        `API_TOKEN=${myzapApiToken}`,
        `APITOKEN=${myzapApiToken}`,
        ''
    ].join('\n');
}

function getBundledEnvContent() {
    const envPath = path.join(__dirname, 'configs', '.env');
    try {
        if (fs.existsSync(envPath)) {
            return fs.readFileSync(envPath, 'utf8');
        }
    } catch (_e) {
        // fallback para default dinÃ¢mico
    }
    return '';
}

async function requestJson(url, token) {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 10000);
    const startedAt = Date.now();

    try {
        debug('MyZap config: iniciando requisicao HTTP', {
            metadata: {
                area: 'autoConfig',
                url
            }
        });

        const res = await fetch(url, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            signal: ctrl.signal
        });

        const contentType = String(res.headers.get('content-type') || '').trim();
        const rawBody = await res.text().catch(() => '');
        let body = {};
        let parseError = null;

        if (rawBody && rawBody.trim()) {
            try {
                body = JSON.parse(rawBody);
            } catch (err) {
                parseError = err?.message || String(err);
            }
        }

        debug('MyZap config: resposta HTTP recebida', {
            metadata: {
                area: 'autoConfig',
                url,
                status: res.status,
                ok: res.ok,
                contentType,
                parseError,
                elapsedMs: Date.now() - startedAt
            }
        });
        return {
            ok: res.ok,
            status: res.status,
            body,
            rawBody,
            contentType,
            parseError
        };
    } catch (error) {
        warn('MyZap config: falha de requisicao HTTP', {
            metadata: {
                area: 'autoConfig',
                url,
                error,
                elapsedMs: Date.now() - startedAt
            }
        });
        return {
            ok: false,
            status: 0,
            body: {},
            rawBody: '',
            contentType: '',
            parseError: null,
            error: error?.message || String(error)
        };
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchRemoteMyZapCredentials({ apiBaseUrl, bearerToken, idempresa }) {
    info('MyZap config: buscando credenciais remotas', {
        metadata: {
            area: 'autoConfig',
            idempresa,
            apiBaseUrl
        }
    });

    const endpoints = [
        `parametrizacao-myzap/config/${idempresa}`,
        `parametrizacao-myzap/credenciais/${idempresa}`,
        `parametrizacao-myzap/configuracao/${idempresa}`,
        `parametrizacao-myzap/empresa/${idempresa}`,
        `parametrizacao-myzap/${idempresa}`,
        `parametrizacao-myzap/config?idempresa=${encodeURIComponent(idempresa)}`,
        `parametrizacao-myzap/credenciais?idempresa=${encodeURIComponent(idempresa)}`,
        `parametrizacao-myzap/configuracao?idempresa=${encodeURIComponent(idempresa)}`,
        `parametrizacao-myzap?idempresa=${encodeURIComponent(idempresa)}`
    ];

    const sessionKeyCandidates = [
        'sessionkey',
        'session_key',
        'sessionKey',
        'myzap_session_key',
        'myzapSessionKey',
        'session_myzap',
        'sessionmyzap'
    ];

    const sessionNameCandidates = [
        'sessionname',
        'session_name',
        'myzap_session_name',
        'myzapSessionName',
        'session_myzap',
        'sessionmyzap'
    ];

    const myzapTokenCandidates = [
        'apitoken',
        'api_token',
        'apiKey',
        'api_key',
        'myzap_api_token',
        'myzapApiToken',
        'sessiontoken',
        'session_token',
        'sessionToken',
        'key_myzap',
        'keymyzap'
    ];

    const envCandidates = [
        'envcontent',
        'env_content',
        'myzap_env',
        'myzap_env_content',
        'arquivo_env',
        'env'
    ];

    const backendApiCandidates = [
        'backendapiurl',
        'backend_api_url',
        'apiurlbackend',
        'api_url_backend',
        'apiurlempresa',
        'clickexpressapiurl',
        'clickexpress_api_url',
        'click_api_url',
        'apiurlclickexpress'
    ];

    const backendTokenCandidates = [
        'backendapitoken',
        'backend_api_token',
        'backendtoken',
        'backend_token',
        'tokenbackend',
        'clickexpressqueuetoken',
        'clickexpress_queue_token',
        'clickqueuetoken',
        'tokenfilaclickexpress'
    ];

    const promptIdCandidates = [
        'promptid',
        'prompt_id',
        'idprompt',
        'myzap_prompt_id',
        'myzappromptid'
    ];

    const iaAtivaCandidates = [
        'iaativa',
        'ia_ativa',
        'myzap_ia_ativa',
        'myzapiaativa',
        'iaenabled',
        'ia_enabled'
    ];

    const modoIntegracaoCandidates = [
        'modoenvio',
        'modo_envio',
        'modointegracao',
        'modo_integracao',
        'modoexecucao',
        'modo_execucao',
        'modomyzap',
        'modo_myzap',
        'tipointegracao',
        'tipo_integracao',
        'tipomyzap',
        'tipo_myzap',
        'integrationmode',
        'integration_mode',
        'myzapmode',
        'myzap_mode'
    ];

    const modoIntegracaoIdCandidates = [
        'modoenvioid',
        'modo_envio_id',
        'modointegracaoid',
        'modo_integracao_id',
        'modomyzapid',
        'modo_myzap_id'
    ];

    const rodarLocalCandidates = [
        'rodarlocal',
        'rodar_local',
        'executarlocal',
        'executar_local',
        'filalocal',
        'fila_local',
        'myzaplocal',
        'myzap_local'
    ];

    const attempts = [];
    const debugRun = {
        generatedAt: Date.now(),
        idempresa,
        apiBaseUrl,
        success: false,
        reason: 'credentials_not_found',
        selectedEndpoint: null,
        selectedData: null,
        attempts: []
    };

    for (const endpoint of endpoints) {
        const url = `${apiBaseUrl}${endpoint}`;
        const response = await requestJson(url, bearerToken);
        const responseBodyForDebug = (
            response?.body
            && typeof response.body === 'object'
            && Object.keys(response.body).length > 0
        )
            ? truncateDebugValue(response.body)
            : (String(response?.rawBody || '').trim() ? truncateText(response.rawBody) : null);

        const attemptRecord = {
            endpoint,
            url,
            status: response.status,
            ok: response.ok,
            error: response.error || null,
            contentType: response.contentType || null,
            parseError: response.parseError || null,
            body: responseBodyForDebug
        };

        attempts.push(attemptRecord);
        debugRun.attempts.push(attemptRecord);

        debug('MyZap config: tentativa de endpoint', {
            metadata: {
                area: 'autoConfig',
                idempresa,
                endpoint,
                status: response.status,
                ok: response.ok,
                error: response.error || null,
                parseError: response.parseError || null
            }
        });

        if (!response.ok || !response.body) {
            continue;
        }

        const flat = flattenObject(response.body);
        const sessionKey = pickFirst(flat, sessionKeyCandidates);
        const sessionName = pickFirst(flat, sessionNameCandidates);
        const myzapApiToken = pickFirst(flat, myzapTokenCandidates);
        const envContent = pickFirst(flat, envCandidates);
        const backendApiUrlRaw = pickFirst(flat, backendApiCandidates);
        const backendApiUrl = sanitizeBackendApiUrl(backendApiUrlRaw, apiBaseUrl);
        const backendApiToken = pickFirst(flat, backendTokenCandidates);
        const promptId = pickFirst(flat, promptIdCandidates);
        const iaAtiva = pickFirst(flat, iaAtivaCandidates);
        const modoIntegracao = pickFirst(flat, modoIntegracaoCandidates);
        const modoIntegracaoId = pickFirst(flat, modoIntegracaoIdCandidates);
        const rodarLocal = pickFirst(flat, rodarLocalCandidates);
        const capabilityHints = extractCapabilityHintsFromFlatMap(flat);

        if (sessionKey && myzapApiToken) {
            const resolvedData = {
                sessionKey,
                sessionName,
                myzapApiToken,
                envContent,
                backendApiUrl,
                backendApiToken,
                promptId,
                iaAtiva,
                modoIntegracao,
                modoIntegracaoId,
                rodarLocal,
                capabilityHints
            };

            debugRun.success = true;
            debugRun.reason = 'credentials_found';
            debugRun.selectedEndpoint = endpoint;
            debugRun.selectedData = truncateDebugValue(resolvedData);
            setLastRemoteConfigDebug(debugRun);

            info('MyZap config: credenciais remotas obtidas com sucesso', {
                metadata: {
                    area: 'autoConfig',
                    idempresa,
                    endpoint,
                    hasPromptId: !!promptId,
                    hasIaAtiva: iaAtiva !== '',
                    capabilityHints
                }
            });
            return {
                ok: true,
                data: resolvedData,
                attempts
            };
        }
    }

    setLastRemoteConfigDebug(debugRun);

    warn('MyZap config: nenhum endpoint retornou credenciais validas', {
        metadata: {
            area: 'autoConfig',
            idempresa,
            attempts
        }
    });

    return {
        ok: false,
        attempts
    };
}

function getBaseCompanyConfig() {
    const apiUrl = normalizeBaseUrl(String(store.get('apiUrl') || '').trim());
    const apiToken = String(store.get('apiToken') || '').trim();
    const idempresa = String(store.get('idempresa') || '').trim();

    return {
        apiUrl,
        apiToken,
        idempresa
    };
}

async function prepareAutoConfig(options = {}) {
    const forceRemote = Boolean(options.forceRemote);
    const base = getBaseCompanyConfig();

    if (!base.apiUrl || !base.apiToken || !base.idempresa) {
        setLastRemoteConfigDebug({
            generatedAt: Date.now(),
            success: false,
            reason: 'missing_base_config',
            baseConfig: {
                hasApiUrl: !!base.apiUrl,
                hasApiToken: !!base.apiToken,
                hasIdempresa: !!base.idempresa
            },
            attempts: []
        });
        return {
            status: 'error',
            message: 'Configure ID da empresa, URL da API e token nas configuracoes principais antes de iniciar o MyZap.'
        };
    }

    const backendProfileKey = buildBackendProfileKey(base);
    const storedBackendProfileKey = String(store.get('myzap_backendProfileKey') || '').trim();
    if (backendProfileKey && storedBackendProfileKey && storedBackendProfileKey !== backendProfileKey) {
        info('MyZap config: backend principal alterado, invalidando cache remoto derivado', {
            metadata: {
                area: 'autoConfig',
                previousBackendProfileKey: storedBackendProfileKey,
                nextBackendProfileKey: backendProfileKey
            }
        });
        clearDerivedBackendState(store);
        store.set('myzap_backendProfileKey', backendProfileKey);
    }

    const myzapDirectoryResolution = resolveMyZapDirectory();
    const myzapDiretorio = myzapDirectoryResolution.dir;
    const currentCapabilitySnapshot = getCapabilitySnapshot(store);
    const currentRemoteHints = getStoredCapabilityRemoteHints(store);
    const currentSessionKey = String(store.get('myzap_sessionKey') || '').trim();
    const currentSessionName = String(store.get('myzap_sessionName') || '').trim();
    const currentMyzapApiToken = String(store.get('myzap_apiToken') || '').trim();
    const currentEnvContent = String(store.get('myzap_envContent') || '').trim();
    const currentPromptId = String(store.get('myzap_promptId') || '').trim();
    const currentIaAtivaRaw = store.get('myzap_iaAtiva');
    const currentIaAtiva = parseBooleanLike(currentIaAtivaRaw, false);
    const currentModoIntegracao = normalizeIntegrationMode(store.get('myzap_modoIntegracao')) || 'local';
    const currentRemoteConfigOk = Boolean(store.get('myzap_remoteConfigOk'));
    const currentRemoteConfigCheckedAt = Number(store.get('myzap_remoteConfigCheckedAt') || 0);
    const lastRemoteSyncAt = Number(store.get(LAST_REMOTE_SYNC_KEY) || 0);
    const remoteIsStale = !lastRemoteSyncAt || (Date.now() - lastRemoteSyncAt >= REMOTE_REFRESH_INTERVAL_MS);

    const shouldFetchRemote = forceRemote || !currentSessionKey || !currentMyzapApiToken || remoteIsStale;
    const remote = shouldFetchRemote
        ? await fetchRemoteMyZapCredentials({
            apiBaseUrl: base.apiUrl,
            bearerToken: base.apiToken,
            idempresa: base.idempresa
        })
        : { ok: false, attempts: [] };
    const remoteFetched = Boolean(remote?.ok);
    const remoteHints = remoteFetched
        ? setStoredCapabilityRemoteHints(remote?.data?.capabilityHints || {}, store)
        : currentRemoteHints;

    if (shouldFetchRemote && !remote?.ok) {
        warn('MyZap config: nao foi possivel atualizar dados remotos, aplicando fallback de cache local', {
            metadata: {
                area: 'autoConfig',
                idempresa: base.idempresa,
                forceRemote,
                remoteIsStale,
                attempts: remote?.attempts || []
            }
        });
    }

    const sessionKey = (remote?.data?.sessionKey || currentSessionKey || '').trim();
    const sessionName = (remote?.data?.sessionName || currentSessionName || sessionKey || '').trim();
    let myzapApiToken = (remote?.data?.myzapApiToken || currentMyzapApiToken || '').trim();
    const backendApiUrl = normalizeBaseUrl((
        sanitizeBackendApiUrl(remote?.data?.backendApiUrl, base.apiUrl)
        || store.get('myzap_backendApiUrl')
        || store.get('clickexpress_apiUrl')
        || base.apiUrl
        || ''
    ).trim());
    const backendApiToken = String(
        remote?.data?.backendApiToken
        || store.get('myzap_backendApiToken')
        || store.get('clickexpress_queueToken')
        || base.apiToken
        || ''
    ).trim();
    const remotePromptId = remoteFetched ? String(remote?.data?.promptId || '').trim() : '';
    const capabilityPromptId = remoteFetched ? remotePromptId : currentPromptId;
    const rawPromptId = remoteFetched ? remotePromptId : (remote?.data?.promptId || currentPromptId || '');
    let promptId = String(rawPromptId || '').trim();
    const capabilityIaAtivaRaw = remoteFetched ? remote?.data?.iaAtiva : currentIaAtivaRaw;
    let iaAtiva = parseBooleanLike(
        remoteFetched ? remote?.data?.iaAtiva : currentIaAtivaRaw,
        currentIaAtiva
    );
    const remoteModoIntegracao = normalizeIntegrationMode(remote?.data?.modoIntegracao);
    const remoteModoIntegracaoId = normalizeIntegrationMode(remote?.data?.modoIntegracaoId);
    const remoteRodarLocal = parseBooleanLike(remote?.data?.rodarLocal, null);
    const modoIntegracao = remoteModoIntegracao
        || remoteModoIntegracaoId
        || (remoteRodarLocal === null ? '' : (remoteRodarLocal ? 'local' : 'web'))
        || currentModoIntegracao
        || 'local';
    const rodarLocal = modoIntegracao === 'local';
    const envContent = (
        remote?.data?.envContent
        || currentEnvContent
        || getBundledEnvContent()
        || (sessionKey && myzapApiToken ? buildDefaultEnv({ sessionKey, myzapApiToken }) : '')
    ).trim();

    // Sincronizar myzap_apiToken com o TOKEN real do .env
    // O TOKEN no .env e o que o MyZap local valida nas chamadas HTTP.
    // A API remota pode devolver myzapApiToken = sessionKey (errado).
    const envTokenMatch = envContent.match(/^TOKEN="?([^"\n\r]+)"?/m);
    if (envTokenMatch && envTokenMatch[1].trim()) {
        const envToken = envTokenMatch[1].trim();
        if (envToken !== myzapApiToken) {
            info('autoConfig: myzap_apiToken corrigido para igualar TOKEN do .env', {
                metadata: { area: 'autoConfig', antigo: myzapApiToken.slice(0, 8) + '...', novo: envToken.slice(0, 8) + '...' }
            });
            myzapApiToken = envToken;
        }
    }

    const capabilitySnapshot = refreshCapabilitySnapshotFromStore(store, {
        previousSnapshot: currentCapabilitySnapshot,
        remoteHints,
        promptId: capabilityPromptId,
        iaAtiva: capabilityIaAtivaRaw,
        remoteFetchOk: remoteFetched
    });

    if (remoteFetched && !capabilitySnapshot?.supportsIaConfig?.enabled) {
        promptId = '';
        iaAtiva = false;
    }

    if (!sessionKey || !myzapApiToken) {
        warn('Nao foi possivel obter credenciais automaticas do MyZap', {
            metadata: {
                idempresa: base.idempresa,
                remoteAttempts: remote?.attempts || []
            }
        });
        return {
            status: 'error',
            message: 'Nao foi possivel obter session key e api key automaticamente da API da empresa.'
        };
    }

    if (!envContent) {
        return {
            status: 'error',
            message: 'Nao foi possivel montar o arquivo .env automatico para o MyZap.'
        };
    }

    const payload = {
        myzap_diretorio: myzapDiretorio,
        myzap_sessionKey: sessionKey,
        myzap_sessionName: sessionName || sessionKey,
        myzap_apiToken: myzapApiToken,
        myzap_envContent: envContent,
        myzap_promptId: promptId,
        myzap_iaAtiva: iaAtiva,
        myzap_modoIntegracao: modoIntegracao,
        myzap_rodarLocal: rodarLocal,
        myzap_remoteConfigOk: shouldFetchRemote ? Boolean(remote?.ok) : currentRemoteConfigOk,
        myzap_remoteConfigCheckedAt: shouldFetchRemote ? Date.now() : currentRemoteConfigCheckedAt,
        [LAST_REMOTE_SYNC_KEY]: remote?.ok ? Date.now() : lastRemoteSyncAt,
        myzap_backendProfileKey: backendProfileKey,
        myzap_backendApiUrl: backendApiUrl,
        myzap_backendApiToken: backendApiToken,
        clickexpress_apiUrl: backendApiUrl,
        clickexpress_queueToken: backendApiToken,
        myzap_capabilityRemoteHints: remoteHints,
        myzap_capabilitySnapshot: capabilitySnapshot
    };

    store.set(payload);

    info('Configuracao automatica do MyZap preparada com sucesso', {
        metadata: {
            idempresa: base.idempresa,
            myzap_diretorio: myzapDiretorio,
            myzap_diretorio_source: myzapDirectoryResolution.source,
            remoteFetched: Boolean(remote?.ok),
            remoteIsStale,
            modoIntegracao,
            rodarLocal,
            forceRemote,
            capabilities: capabilitySnapshot
        }
    });

    return {
        status: 'success',
        message: 'Configuracao automatica do MyZap pronta.',
        data: {
            ...payload,
            myzap_capabilitySnapshot: capabilitySnapshot
        }
    };
}

async function syncIaSettingsInMyZap(preparedData = {}) {
    const capabilitySnapshot = preparedData?.myzap_capabilitySnapshot || getCapabilitySnapshot(store);
    if (!capabilitySnapshot?.supportsIaConfig?.enabled) {
        info('MyZap IA: sincronizacao ignorada porque a capability esta desabilitada ou ausente', {
            metadata: {
                area: 'autoConfig',
                capability: capabilitySnapshot?.supportsIaConfig || null
            }
        });
        return {
            status: 'skipped',
            reason: capabilitySnapshot?.supportsIaConfig?.reason || 'capability_disabled',
            message: 'Configuracao de IA ignorada: recurso nao suportado ou desabilitado.'
        };
    }

    const maxRetries = 2;
    const retryDelayMs = 3000;
    let lastResult = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        lastResult = await updateIaConfig({
            mensagemPadrao: store.get('myzap_mensagemPadrao') || '',
            promptId: preparedData?.myzap_promptId ?? store.get('myzap_promptId'),
            iaAtiva: preparedData?.myzap_iaAtiva ?? store.get('myzap_iaAtiva'),
            token: preparedData?.myzap_apiToken ?? store.get('myzap_apiToken'),
            sessionKey: preparedData?.myzap_sessionKey ?? store.get('myzap_sessionKey'),
            sessionName: preparedData?.myzap_sessionName ?? store.get('myzap_sessionName')
        });

        if (lastResult?.status === 'success' || lastResult?.status === 'skipped') {
            return lastResult;
        }

        if (attempt < maxRetries) {
            warn(`syncIaSettingsInMyZap: tentativa ${attempt} falhou, retentando em ${retryDelayMs}ms...`, {
                metadata: { attempt, result: lastResult }
            });
            await new Promise((r) => setTimeout(r, retryDelayMs));
        }
    }

    warn('Falha ao sincronizar prompt/ia_ativa no MyZap local apos retries', {
        metadata: { result: lastResult, maxRetries }
    });

    return lastResult;
}

async function ensureMyZapReadyAndStart(options = {}) {
    if (ensureInFlight) {
        // Detecta operacao travada (stale) apos 2 minutos
        const elapsed = Date.now() - ensureInFlightStartedAt;
        if (elapsed > ENSURE_STALE_TIMEOUT_MS) {
            warn('ensureMyZapReadyAndStart: operacao anterior considerada stale, resetando', {
                metadata: { area: 'autoConfig', elapsedMs: elapsed }
            });
            ensureInFlight = null;
            ensureInFlightStartedAt = 0;
        } else {
            info('MyZap start: operacao ja em andamento, aguardando mesma execucao', {
                metadata: { area: 'autoConfig', options, elapsedMs: elapsed }
            });
            return ensureInFlight;
        }
    }

    ensureInFlightStartedAt = Date.now();
    ensureInFlight = (async () => {
        transition('checking_config', { message: 'Iniciando sincronizacao do MyZap...' });
        startProgress('Iniciando sincronizacao do MyZap...', 'start', { options });

        const prep = await prepareAutoConfig(options);
        if (prep.status !== 'success') {
            warn('MyZap start: preparacao falhou', {
                metadata: {
                    area: 'autoConfig',
                    options,
                    prep
                }
            });
            finishProgressError(prep.message || 'Falha na preparacao do MyZap.', 'prepare');
            return prep;
        }

        if (options.forceRemote && !prep.data?.myzap_remoteConfigOk) {
            const result = {
                status: 'error',
                message: 'Nao foi possivel validar a configuracao remota do MyZap na API. Nenhuma acao local foi executada.'
            };
            warn('MyZap start: validacao remota obrigatoria falhou', {
                metadata: {
                    area: 'autoConfig',
                    options,
                    result
                }
            });
            finishProgressError(result.message, 'remote_validate');
            return result;
        }

        if (!prep.data?.myzap_rodarLocal) {
            info('MyZap start: modo web/online detectado, iniciacao local ignorada', {
                metadata: {
                    area: 'autoConfig',
                    modoIntegracao: prep?.data?.myzap_modoIntegracao
                }
            });
            finishProgressSuccess('Modo web/online ativo. Nenhuma instalacao local necessaria.', 'mode_web', {
                modoIntegracao: prep?.data?.myzap_modoIntegracao
            });
            return {
                status: 'success',
                message: 'MyZap configurado em modo web/online. Execucao local ignorada.',
                skippedLocalStart: true,
                data: prep.data
            };
        }

        const dirPath = prep.data.myzap_diretorio;
        const envContent = prep.data.myzap_envContent;

        stepProgress('Verificando instalacao local do MyZap...', 'check_install', {
            dirPath
        });
        const checkDir = await verificarDiretorio(dirPath);

        const reportProgress = (message, phase, metadata = {}) => {
            stepProgress(message, phase, metadata);
        };

        let startResult;
        if (checkDir.status === 'success') {
            stepProgress('Instalacao encontrada. Aplicando configuracoes locais...', 'update_existing_install', {
                dirPath
            });
            startResult = await atualizarEnv(dirPath, envContent, {
                onProgress: reportProgress
            });
        } else {
            stepProgress('Instalacao local nao encontrada. Iniciando instalacao (clone/dependencias)...', 'install_local', {
                dirPath
            });
            startResult = await clonarRepositorio(dirPath, envContent, false, {
                onProgress: reportProgress
            });
        }

        if (startResult.status !== 'success') {
            warn('MyZap start: falha ao preparar ou iniciar ambiente local', {
                metadata: {
                    area: 'autoConfig',
                    dirPath,
                    startResult
                }
            });
            finishProgressError(startResult.message || 'Falha ao iniciar ambiente local do MyZap.', 'start_local', {
                dirPath
            });
            return startResult;
        }

        const syncIaResult = await syncIaSettingsInMyZap(prep.data);
        if (syncIaResult?.status === 'skipped') {
            stepProgress('Configuracoes opcionais de IA ignoradas por nao suportadas.', 'sync_ia', {
                dirPath,
                skipped: true,
                reason: syncIaResult?.reason || null
            });
        } else {
            stepProgress('Sincronizando configuracoes de IA no MyZap local...', 'sync_ia', {
                dirPath
            });
        }
        info('MyZap start: ambiente local iniciado e sincronizacao opcional de IA processada', {
            metadata: {
                area: 'autoConfig',
                dirPath,
                syncIaStatus: syncIaResult?.status || 'error',
                syncIaReason: syncIaResult?.reason || null
            }
        });

        finishProgressSuccess('MyZap local pronto para uso.', 'done', {
            dirPath,
            syncIaStatus: syncIaResult?.status || 'error'
        });

        return {
            ...startResult,
            syncIa: syncIaResult?.status || 'error',
            syncIaMessage: syncIaResult?.message || 'Falha ao sincronizar configuracao de IA.'
        };
    })().finally(() => {
        ensureInFlight = null;
        ensureInFlightStartedAt = 0;
    });

    return ensureInFlight;
}

async function refreshRemoteConfigAndSyncIa() {
    // Se o usuario removeu a instalacao local, nao repopular store
    if (store.get('myzap_userRemovedLocal') === true) {
        info('refreshRemoteConfigAndSyncIa: ignorado (myzap_userRemovedLocal=true)', {
            metadata: { area: 'autoConfig' }
        });
        return { status: 'skipped', message: 'Ignorado: usuario removeu instalacao local.' };
    }

    const prep = await prepareAutoConfig({ forceRemote: true });
    if (prep.status !== 'success') {
        warn('MyZap refresh: falha ao atualizar configuracao remota', {
            metadata: {
                area: 'autoConfig',
                prep
            }
        });
        return prep;
    }

    if (!prep.data?.myzap_remoteConfigOk) {
        return {
            status: 'error',
            message: 'Nao foi possivel validar configuracao remota do MyZap na API neste ciclo.',
            data: prep.data
        };
    }

    if (!prep.data?.myzap_rodarLocal) {
        info('MyZap refresh: modo web/online detectado, sem sync local', {
            metadata: {
                area: 'autoConfig',
                modoIntegracao: prep?.data?.myzap_modoIntegracao
            }
        });
        return {
            status: 'success',
            message: 'Configuracao remota atualizada (modo web/online, sem sync local).',
            skippedLocalStart: true,
            data: prep.data
        };
    }

    const syncIaResult = await syncIaSettingsInMyZap(prep.data);
    if (syncIaResult?.status === 'success' || syncIaResult?.status === 'skipped') {
        info('MyZap refresh: configuracao remota processada com o MyZap local', {
            metadata: {
                area: 'autoConfig',
                modoIntegracao: prep?.data?.myzap_modoIntegracao,
                syncIaStatus: syncIaResult?.status || 'unknown'
            }
        });
        return {
            status: 'success',
            message: syncIaResult?.status === 'skipped'
                ? 'Configuracao remota do MyZap atualizada. Recurso opcional de IA foi ignorado.'
                : 'Configuracao remota do MyZap atualizada e sincronizada.',
            data: prep.data
        };
    }

    return {
        status: 'error',
        message: syncIaResult?.message || 'Falha ao sincronizar configuracao de IA no MyZap.',
        data: prep.data
    };
}

module.exports = {
    getDefaultMyZapDirectory,
    getAutoConfigDebugSnapshot,
    prepareAutoConfig,
    ensureMyZapReadyAndStart,
    refreshRemoteConfigAndSyncIa
};
