const Store = require('electron-store');
const store = new Store();
const { info, warn, error, debug } = require('../myzapLogger');
const {
    parseBooleanLike,
    normalizeCapabilityMode,
    getCapabilityEntry,
    markCapabilityRuntimeUnavailable,
    clearCapabilityRuntimeUnavailable
} = require('../capabilities');

function normalizeUpdateArgs(rawInput) {
    if (typeof rawInput === 'string') {
        return { mensagemPadrao: rawInput };
    }

    if (rawInput && typeof rawInput === 'object') {
        return {
            mensagemPadrao: rawInput.mensagemPadrao,
            promptId: rawInput.promptId,
            iaAtiva: rawInput.iaAtiva,
            token: rawInput.token,
            sessionKey: rawInput.sessionKey,
            sessionName: rawInput.sessionName
        };
    }

    return {};
}

function isMissingIaConfigResponse(status, data = {}) {
    const errorText = String(
        data?.error
        || data?.message
        || data?.mensagem
        || ''
    ).trim().toLowerCase();

    if (status === 404) {
        return true;
    }

    if (!errorText) {
        return false;
    }

    return (
        errorText.includes('configuracao nao encontrada')
        || errorText.includes('configuração não encontrada')
        || errorText.includes('configuracao não encontrada')
        || errorText.includes('configuração nao encontrada')
    );
}

async function updateIaConfig(rawInput) {
    const input = normalizeUpdateArgs(rawInput);
    const token = String(input.token || store.get('myzap_apiToken') || '').trim();
    const api = 'http://localhost:5555/';
    const sessionKey = String(input.sessionKey || store.get('myzap_sessionKey') || '').trim();
    const sessionName = String(input.sessionName || store.get('myzap_sessionName') || sessionKey).trim();
    const mensagemPadrao = String(
        input.mensagemPadrao !== undefined
            ? input.mensagemPadrao
            : (store.get('myzap_mensagemPadrao') || '')
    );
    const promptId = String(
        input.promptId !== undefined
            ? input.promptId
            : (store.get('myzap_promptId') || '')
    ).trim();
    const iaAtiva = parseBooleanLike(
        input.iaAtiva !== undefined ? input.iaAtiva : store.get('myzap_iaAtiva'),
        false
    );
    const iaCapability = getCapabilityEntry('supportsIaConfig', store);
    const iaCapabilityMode = normalizeCapabilityMode(store.get('myzap_capabilityIaConfigMode') || 'auto');

    store.set({
        myzap_mensagemPadrao: mensagemPadrao
    });

    if (!iaCapability?.enabled) {
        info('Configuracao opcional de IA ignorada por nao suportada ou desabilitada', {
            metadata: {
                area: 'updateIaConfig',
                capability: iaCapability || null
            }
        });
        return {
            status: 'skipped',
            reason: iaCapability?.reason || 'capability_disabled',
            message: 'Configuracao de IA ignorada: recurso nao suportado ou desabilitado.'
        };
    }

    if (!token) {
        warn('Token nao encontrado', {
            metadata: { area: 'updateIaConfig', missing: 'token' }
        });
        return { status: 'error', message: 'Token do MyZap nao encontrado.' };
    }

    if (!sessionKey) {
        warn('Session nao encontrada', {
            metadata: { area: 'updateIaConfig', missing: 'sessionKey' }
        });
        return { status: 'error', message: 'Session key do MyZap nao encontrada.' };
    }

    try {
        debug('Atualizando configuracao de IA MyZap', {
            metadata: {
                area: 'updateIaConfig',
                sessionKey,
                sessionName,
                promptId: promptId || null,
                iaAtiva
            }
        });

        const payload = {
            session: sessionName || sessionKey,
            sessionkey: sessionKey,
            session_name: sessionName || sessionKey,
            mensagem_padrao: mensagemPadrao,
            api_url: null,
            idprompt: promptId || null,
            ia_ativa: iaAtiva ? 1 : 0
        };

        const res = await fetch(`${api}admin/ia-manager/update-config`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                apitoken: token,
                sessionkey: sessionKey
            },
            body: JSON.stringify(payload)
        });

        const data = await res.json().catch(() => ({}));
        if (isMissingIaConfigResponse(res.status, data)) {
            warn('Configuracao opcional de IA nao encontrada no MyZap local. Fluxo principal sera mantido.', {
                metadata: {
                    area: 'updateIaConfig',
                    httpStatus: res.status,
                    capabilityMode: iaCapabilityMode,
                    response: data
                }
            });

            if (iaCapabilityMode === 'auto') {
                markCapabilityRuntimeUnavailable(
                    'supportsIaConfig',
                    'local_ia_config_not_supported',
                    {
                        httpStatus: res.status,
                        response: data
                    },
                    store
                );
            }

            return {
                status: 'skipped',
                reason: 'local_ia_config_not_supported',
                message: 'Configuracao opcional de IA nao suportada ou nao configurada no MyZap local.',
                data
            };
        }

        if (!res.ok || data?.error) {
            return {
                status: 'error',
                message: data?.error || `Falha ao atualizar configuracao de IA no MyZap (HTTP ${res.status}).`,
                data
            };
        }

        clearCapabilityRuntimeUnavailable('supportsIaConfig', store);

        store.set({
            myzap_mensagemPadrao: mensagemPadrao,
            myzap_promptId: promptId,
            myzap_iaAtiva: iaAtiva
        });

        return {
            status: 'success',
            message: 'Configuracao de IA sincronizada no MyZap.',
            data
        };
    } catch (e) {
        error('Erro ao atualizar configuracao de IA MyZap', {
            metadata: { area: 'updateIaConfig', error: e }
        });
        return { status: 'error', message: e?.message || String(e) };
    }
}

module.exports = updateIaConfig;
