const Store = require('electron-store');

const store = new Store();

const CAPABILITY_DEFINITIONS = {
    supportsIaConfig: {
        preferenceKey: 'myzap_capabilityIaConfigMode',
        defaultMode: 'auto',
        defaultEnabled: false
    },
    supportsTokenSync: {
        preferenceKey: 'myzap_capabilityTokenSyncMode',
        defaultMode: 'auto',
        defaultEnabled: false
    },
    supportsPassiveStatus: {
        preferenceKey: 'myzap_capabilityPassiveStatusMode',
        defaultMode: 'auto',
        defaultEnabled: true
    },
    supportsQueuePolling: {
        preferenceKey: 'myzap_capabilityQueuePollingMode',
        defaultMode: 'auto',
        defaultEnabled: true
    }
};

const RUNTIME_CAPABILITY_STATES = new Map();

function normalizeBaseUrl(url) {
    if (!url || typeof url !== 'string') return '';
    const trimmed = String(url).trim();
    if (!trimmed) return '';
    return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function sanitizeBackendApiUrl(rawUrl, fallbackUrl = '') {
    const normalizedFallback = normalizeBaseUrl(fallbackUrl);
    const normalizedRaw = normalizeBaseUrl(rawUrl);

    if (!normalizedRaw) {
        return normalizedFallback;
    }

    try {
        const parsed = new URL(normalizedRaw);
        const segments = String(parsed.pathname || '')
            .split('/')
            .filter(Boolean);
        const blockedSegmentIndex = segments.findIndex((segment) => (
            String(segment || '').trim().toLowerCase() === 'parametrizacao-myzap'
        ));

        if (blockedSegmentIndex >= 0) {
            const baseSegments = segments.slice(0, blockedSegmentIndex);
            parsed.pathname = baseSegments.length > 0
                ? `/${baseSegments.join('/')}/`
                : '/';
            parsed.search = '';
            parsed.hash = '';
        }

        return normalizeBaseUrl(parsed.toString());
    } catch (_error) {
        const stripped = normalizedRaw.replace(/\/parametrizacao-myzap(?:\/.*)?$/i, '/');
        return normalizeBaseUrl(stripped || normalizedFallback);
    }
}

function parseBooleanLike(value, defaultValue = null) {
    if (value === undefined || value === null || value === '') {
        return defaultValue;
    }

    if (typeof value === 'boolean') {
        return value;
    }

    if (typeof value === 'number') {
        if (value === 1) return true;
        if (value === 0) return false;
    }

    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'sim', 'yes', 'y', 'on', 'ativo', 'enabled', 'habilitado'].includes(normalized)) {
        return true;
    }

    if (['0', 'false', 'nao', 'não', 'no', 'off', 'inativo', 'disabled', 'desabilitado'].includes(normalized)) {
        return false;
    }

    return defaultValue;
}

function normalizeCapabilityMode(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'enabled' || normalized === 'on' || normalized === 'true' || normalized === '1') {
        return 'enabled';
    }

    if (normalized === 'disabled' || normalized === 'off' || normalized === 'false' || normalized === '0') {
        return 'disabled';
    }

    return 'auto';
}

function getCapabilityDefinitions() {
    return { ...CAPABILITY_DEFINITIONS };
}

function getCapabilityKeys() {
    return Object.keys(CAPABILITY_DEFINITIONS);
}

function getCapabilityPreferenceModes(storeLike = store) {
    return getCapabilityKeys().reduce((acc, capability) => {
        const definition = CAPABILITY_DEFINITIONS[capability];
        acc[capability] = normalizeCapabilityMode(
            storeLike.get(definition.preferenceKey) || definition.defaultMode
        );
        return acc;
    }, {});
}

function getStoredCapabilityRemoteHints(storeLike = store) {
    const raw = storeLike.get('myzap_capabilityRemoteHints');
    if (!raw || typeof raw !== 'object') {
        return {};
    }

    return getCapabilityKeys().reduce((acc, capability) => {
        const value = parseBooleanLike(raw[capability], null);
        if (value !== null) {
            acc[capability] = value;
        }
        return acc;
    }, {});
}

function setStoredCapabilityRemoteHints(hints = {}, storeLike = store) {
    const normalized = getCapabilityKeys().reduce((acc, capability) => {
        const value = parseBooleanLike(hints[capability], null);
        if (value !== null) {
            acc[capability] = value;
        }
        return acc;
    }, {});

    storeLike.set('myzap_capabilityRemoteHints', normalized);
    return normalized;
}

function getRuntimeCapabilityStates() {
    return getCapabilityKeys().reduce((acc, capability) => {
        if (RUNTIME_CAPABILITY_STATES.has(capability)) {
            acc[capability] = RUNTIME_CAPABILITY_STATES.get(capability);
        }
        return acc;
    }, {});
}

function setRuntimeCapabilityState(capability, state) {
    if (!CAPABILITY_DEFINITIONS[capability]) {
        return null;
    }

    if (!state || typeof state !== 'object') {
        RUNTIME_CAPABILITY_STATES.delete(capability);
        return null;
    }

    const normalized = {
        enabled: Boolean(state.enabled),
        source: String(state.source || 'runtime'),
        reason: String(state.reason || 'runtime_override')
    };

    if (state.metadata && typeof state.metadata === 'object') {
        normalized.metadata = state.metadata;
    }

    RUNTIME_CAPABILITY_STATES.set(capability, normalized);
    return normalized;
}

function clearRuntimeCapabilityState(capability = null) {
    if (!capability) {
        RUNTIME_CAPABILITY_STATES.clear();
        return;
    }

    RUNTIME_CAPABILITY_STATES.delete(capability);
}

function getCapabilitySnapshot(storeLike = store) {
    const raw = storeLike.get('myzap_capabilitySnapshot');
    if (!raw || typeof raw !== 'object') {
        return {
            generatedAt: 0
        };
    }

    const snapshot = {
        generatedAt: Number(raw.generatedAt || 0)
    };

    getCapabilityKeys().forEach((capability) => {
        const entry = raw[capability];
        if (!entry || typeof entry !== 'object') return;
        snapshot[capability] = {
            enabled: Boolean(entry.enabled),
            source: String(entry.source || ''),
            reason: String(entry.reason || '')
        };
        if (entry.mode) {
            snapshot[capability].mode = normalizeCapabilityMode(entry.mode);
        }
        if (entry.metadata && typeof entry.metadata === 'object') {
            snapshot[capability].metadata = entry.metadata;
        }
    });

    return snapshot;
}

function persistCapabilitySnapshot(snapshot, storeLike = store) {
    const normalized = {
        generatedAt: Number(snapshot?.generatedAt || Date.now())
    };

    getCapabilityKeys().forEach((capability) => {
        const entry = snapshot?.[capability] || {};
        normalized[capability] = {
            enabled: Boolean(entry.enabled),
            source: String(entry.source || ''),
            reason: String(entry.reason || ''),
            mode: normalizeCapabilityMode(entry.mode || 'auto')
        };
        if (entry.metadata && typeof entry.metadata === 'object') {
            normalized[capability].metadata = entry.metadata;
        }
    });

    storeLike.set('myzap_capabilitySnapshot', normalized);
    return normalized;
}

function buildBackendProfileKey({ apiUrl, idempresa }) {
    const normalizedApiUrl = normalizeBaseUrl(apiUrl).toLowerCase();
    const normalizedCompanyId = String(idempresa || '').trim();
    if (!normalizedApiUrl && !normalizedCompanyId) {
        return '';
    }
    return `${normalizedApiUrl}|${normalizedCompanyId}`;
}

function clearDerivedBackendState(storeLike = store) {
    const keys = [
        'myzap_sessionKey',
        'myzap_sessionName',
        'myzap_promptId',
        'myzap_iaAtiva',
        'myzap_modoIntegracao',
        'myzap_rodarLocal',
        'myzap_remoteConfigOk',
        'myzap_remoteConfigCheckedAt',
        'myzap_lastRemoteConfigSyncAt',
        'myzap_backendApiUrl',
        'myzap_backendApiToken',
        'clickexpress_apiUrl',
        'clickexpress_queueToken',
        'myzap_capabilitySnapshot',
        'myzap_capabilityRemoteHints',
        'myzap_tokenSyncLastAt',
        'myzap_tokenSyncLastTotal'
    ];

    keys.forEach((key) => storeLike.delete(key));
}

function extractCapabilityHintsFromFlatMap(flatMap) {
    if (!(flatMap instanceof Map)) {
        return {};
    }

    const aliasGroups = {
        supportsIaConfig: [
            'supportsIaConfig',
            'supports_ia_config',
            'supportsiaconfig',
            'suportaia',
            'suporta_ia',
            'suportaia_config',
            'suporta_ia_config'
        ],
        supportsTokenSync: [
            'supportsTokenSync',
            'supports_token_sync',
            'supportstokensync',
            'suportatokensync',
            'suporta_token_sync',
            'suporta_tokens_sync'
        ],
        supportsPassiveStatus: [
            'supportsPassiveStatus',
            'supports_passive_status',
            'supportspassivestatus',
            'suportastatuspassivo',
            'suporta_status_passivo',
            'suporta_statuspassivo'
        ],
        supportsQueuePolling: [
            'supportsQueuePolling',
            'supports_queue_polling',
            'supportsqueuepolling',
            'suportafila',
            'suporta_fila',
            'suportaqueuepolling',
            'suporta_queue_polling'
        ]
    };

    return Object.entries(aliasGroups).reduce((acc, [capability, aliases]) => {
        for (const alias of aliases) {
            const normalizedKey = String(alias || '')
                .replace(/[^a-zA-Z0-9]/g, '')
                .toLowerCase();
            const value = parseBooleanLike(flatMap.get(normalizedKey), null);
            if (value !== null) {
                acc[capability] = value;
                break;
            }
        }
        return acc;
    }, {});
}

function buildCapabilityEntry({ capability, preferences, remoteHints, previousSnapshot, remoteFetchOk, context }) {
    const definition = CAPABILITY_DEFINITIONS[capability];
    const mode = normalizeCapabilityMode(preferences[capability] || definition.defaultMode);
    const previousEntry = previousSnapshot?.[capability];
    const runtimeEntry = getRuntimeCapabilityStates()[capability];

    if (mode === 'enabled') {
        return {
            enabled: true,
            source: 'manual',
            reason: 'manual_enabled',
            mode
        };
    }

    if (mode === 'disabled') {
        return {
            enabled: false,
            source: 'manual',
            reason: 'manual_disabled',
            mode
        };
    }

    if (runtimeEntry) {
        return {
            enabled: Boolean(runtimeEntry.enabled),
            source: String(runtimeEntry.source || 'runtime'),
            reason: String(runtimeEntry.reason || 'runtime_override'),
            mode,
            metadata: runtimeEntry.metadata
        };
    }

    if (Object.prototype.hasOwnProperty.call(remoteHints, capability)) {
        return {
            enabled: Boolean(remoteHints[capability]),
            source: 'remote_hint',
            reason: `remote_hint_${remoteHints[capability] ? 'enabled' : 'disabled'}`,
            mode
        };
    }

    if (capability === 'supportsIaConfig') {
        if (remoteFetchOk) {
            const enabled = Boolean(context.hasPromptId || context.hasIaMarker);
            return {
                enabled,
                source: 'inference',
                reason: enabled ? 'remote_ia_fields_present' : 'remote_ia_fields_missing',
                mode
            };
        }

        if (previousEntry) {
            return {
                enabled: Boolean(previousEntry.enabled),
                source: 'cached',
                reason: previousEntry.reason || 'cached_previous_snapshot',
                mode
            };
        }

        const enabled = Boolean(context.hasPromptId || context.hasIaValue);
        return {
            enabled,
            source: enabled ? 'inference' : 'default',
            reason: enabled ? 'cached_ia_fields_present' : 'default_disabled',
            mode
        };
    }

    if (capability === 'supportsTokenSync') {
        const enabled = Boolean(context.supportsIaConfigEnabled && context.iaAtiva === true);
        if (remoteFetchOk || context.hasIaValue || previousEntry) {
            return {
                enabled,
                source: 'inference',
                reason: enabled ? 'ia_supported_and_active' : 'ia_unavailable_or_inactive',
                mode
            };
        }

        return {
            enabled: definition.defaultEnabled,
            source: 'default',
            reason: definition.defaultEnabled ? 'default_enabled' : 'default_disabled',
            mode
        };
    }

    if (!remoteFetchOk && previousEntry) {
        return {
            enabled: Boolean(previousEntry.enabled),
            source: 'cached',
            reason: previousEntry.reason || 'cached_previous_snapshot',
            mode
        };
    }

    return {
        enabled: definition.defaultEnabled,
        source: 'default',
        reason: definition.defaultEnabled ? 'default_enabled' : 'default_disabled',
        mode
    };
}

function resolveCapabilities({
    preferences = {},
    remoteHints = {},
    previousSnapshot = {},
    promptId = '',
    iaAtiva = null,
    remoteFetchOk = false
} = {}) {
    const normalizedPreferences = getCapabilityKeys().reduce((acc, capability) => {
        acc[capability] = normalizeCapabilityMode(
            preferences[capability] || CAPABILITY_DEFINITIONS[capability].defaultMode
        );
        return acc;
    }, {});

    const normalizedRemoteHints = getCapabilityKeys().reduce((acc, capability) => {
        const value = parseBooleanLike(remoteHints[capability], null);
        if (value !== null) {
            acc[capability] = value;
        }
        return acc;
    }, {});

    const normalizedPromptId = String(promptId || '').trim();
    const iaAtivaValue = parseBooleanLike(iaAtiva, null);
    const hasIaMarker = iaAtiva !== undefined && iaAtiva !== null && iaAtiva !== '';
    const hasIaValue = iaAtivaValue !== null;

    const supportsIaConfig = buildCapabilityEntry({
        capability: 'supportsIaConfig',
        preferences: normalizedPreferences,
        remoteHints: normalizedRemoteHints,
        previousSnapshot,
        remoteFetchOk,
        context: {
            hasPromptId: !!normalizedPromptId,
            hasIaMarker,
            hasIaValue,
            iaAtiva: iaAtivaValue
        }
    });

    const supportsPassiveStatus = buildCapabilityEntry({
        capability: 'supportsPassiveStatus',
        preferences: normalizedPreferences,
        remoteHints: normalizedRemoteHints,
        previousSnapshot,
        remoteFetchOk,
        context: {
            supportsIaConfigEnabled: supportsIaConfig.enabled,
            hasPromptId: !!normalizedPromptId,
            hasIaMarker,
            hasIaValue,
            iaAtiva: iaAtivaValue
        }
    });

    const supportsQueuePolling = buildCapabilityEntry({
        capability: 'supportsQueuePolling',
        preferences: normalizedPreferences,
        remoteHints: normalizedRemoteHints,
        previousSnapshot,
        remoteFetchOk,
        context: {
            supportsIaConfigEnabled: supportsIaConfig.enabled,
            hasPromptId: !!normalizedPromptId,
            hasIaMarker,
            hasIaValue,
            iaAtiva: iaAtivaValue
        }
    });

    const supportsTokenSync = buildCapabilityEntry({
        capability: 'supportsTokenSync',
        preferences: normalizedPreferences,
        remoteHints: normalizedRemoteHints,
        previousSnapshot,
        remoteFetchOk,
        context: {
            supportsIaConfigEnabled: supportsIaConfig.enabled,
            hasPromptId: !!normalizedPromptId,
            hasIaMarker,
            hasIaValue,
            iaAtiva: iaAtivaValue
        }
    });

    return {
        generatedAt: Date.now(),
        supportsIaConfig,
        supportsTokenSync,
        supportsPassiveStatus,
        supportsQueuePolling
    };
}

function refreshCapabilitySnapshotFromStore(storeLike = store, overrides = {}) {
    const previousSnapshot = overrides.previousSnapshot || getCapabilitySnapshot(storeLike);
    const preferences = overrides.preferences || getCapabilityPreferenceModes(storeLike);
    const remoteHints = overrides.remoteHints || getStoredCapabilityRemoteHints(storeLike);
    const snapshot = resolveCapabilities({
        preferences,
        remoteHints,
        previousSnapshot,
        promptId: overrides.promptId !== undefined ? overrides.promptId : storeLike.get('myzap_promptId'),
        iaAtiva: overrides.iaAtiva !== undefined ? overrides.iaAtiva : storeLike.get('myzap_iaAtiva'),
        remoteFetchOk: overrides.remoteFetchOk !== undefined
            ? Boolean(overrides.remoteFetchOk)
            : Boolean(storeLike.get('myzap_remoteConfigOk'))
    });

    return persistCapabilitySnapshot(snapshot, storeLike);
}

function setCapabilityPreferenceModes(input = {}, storeLike = store) {
    const payload = {};
    getCapabilityKeys().forEach((capability) => {
        const definition = CAPABILITY_DEFINITIONS[capability];
        if (!Object.prototype.hasOwnProperty.call(input, capability)) {
            return;
        }
        payload[definition.preferenceKey] = normalizeCapabilityMode(input[capability]);
    });

    if (Object.keys(payload).length > 0) {
        storeLike.set(payload);
    }

    return getCapabilityPreferenceModes(storeLike);
}

function getCapabilitySnapshotPayload(storeLike = store) {
    return {
        status: 'success',
        preferences: getCapabilityPreferenceModes(storeLike),
        snapshot: getCapabilitySnapshot(storeLike)
    };
}

function saveCapabilityPreferences(input = {}, storeLike = store) {
    const preferences = setCapabilityPreferenceModes(input, storeLike);
    const snapshot = refreshCapabilitySnapshotFromStore(storeLike, { preferences });

    return {
        status: 'success',
        message: 'Preferencias de capabilities salvas com sucesso.',
        preferences,
        snapshot
    };
}

function isCapabilityEnabled(capability, storeLike = store) {
    const snapshot = getCapabilitySnapshot(storeLike);
    return Boolean(snapshot?.[capability]?.enabled);
}

function getCapabilityEntry(capability, storeLike = store) {
    const snapshot = getCapabilitySnapshot(storeLike);
    return snapshot?.[capability] || null;
}

function markCapabilityRuntimeUnavailable(capability, reason, metadata = {}, storeLike = store) {
    if (!CAPABILITY_DEFINITIONS[capability]) {
        return null;
    }

    const runtimeEntry = setRuntimeCapabilityState(capability, {
        enabled: false,
        source: 'runtime',
        reason,
        metadata
    });

    const snapshot = refreshCapabilitySnapshotFromStore(storeLike, {
        previousSnapshot: getCapabilitySnapshot(storeLike)
    });

    return {
        runtimeEntry,
        snapshot
    };
}

function clearCapabilityRuntimeUnavailable(capability, storeLike = store) {
    clearRuntimeCapabilityState(capability);
    return refreshCapabilitySnapshotFromStore(storeLike, {
        previousSnapshot: getCapabilitySnapshot(storeLike)
    });
}

function getBackendApiConfig(storeLike = store) {
    const rawMyzapBackendApiUrl = String(storeLike.get('myzap_backendApiUrl') || '').trim();
    const rawLegacyBackendApiUrl = String(storeLike.get('clickexpress_apiUrl') || '').trim();
    const rawPrimaryApiUrl = String(storeLike.get('apiUrl') || '').trim();
    const backendApiUrl = sanitizeBackendApiUrl(
        rawMyzapBackendApiUrl
        || rawLegacyBackendApiUrl
        || rawPrimaryApiUrl,
        rawPrimaryApiUrl
    );
    const backendApiToken = String(
        storeLike.get('myzap_backendApiToken')
        || storeLike.get('clickexpress_queueToken')
        || storeLike.get('apiToken')
        || ''
    ).trim();

    const patch = {};
    if (backendApiUrl) {
        if (!rawMyzapBackendApiUrl || normalizeBaseUrl(rawMyzapBackendApiUrl) !== backendApiUrl) {
            patch.myzap_backendApiUrl = backendApiUrl;
        }

        if (rawLegacyBackendApiUrl && normalizeBaseUrl(rawLegacyBackendApiUrl) !== backendApiUrl) {
            patch.clickexpress_apiUrl = backendApiUrl;
        }
    }

    if (Object.keys(patch).length > 0) {
        storeLike.set(patch);
    }

    return {
        backendApiUrl,
        backendApiToken
    };
}

module.exports = {
    CAPABILITY_DEFINITIONS,
    parseBooleanLike,
    normalizeCapabilityMode,
    getCapabilityDefinitions,
    getCapabilityKeys,
    getCapabilityPreferenceModes,
    getStoredCapabilityRemoteHints,
    setStoredCapabilityRemoteHints,
    getRuntimeCapabilityStates,
    setRuntimeCapabilityState,
    clearRuntimeCapabilityState,
    getCapabilitySnapshot,
    persistCapabilitySnapshot,
    buildBackendProfileKey,
    clearDerivedBackendState,
    extractCapabilityHintsFromFlatMap,
    resolveCapabilities,
    refreshCapabilitySnapshotFromStore,
    getCapabilitySnapshotPayload,
    saveCapabilityPreferences,
    isCapabilityEnabled,
    getCapabilityEntry,
    markCapabilityRuntimeUnavailable,
    clearCapabilityRuntimeUnavailable,
    getBackendApiConfig,
    normalizeBaseUrl,
    sanitizeBackendApiUrl
};
