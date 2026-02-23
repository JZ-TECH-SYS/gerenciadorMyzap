const Store = require('electron-store');
const store = new Store();
const { warn, error, debug } = require('../myzapLogger');

function parseBooleanLike(value, defaultValue = false) {
    if (value === undefined || value === null || value === '') return defaultValue;
    const normalized = String(value).trim().toLowerCase();

    if (['1', 'true', 'sim', 'yes', 'y', 'on', 'ativo'].includes(normalized)) {
        return true;
    }

    if (['0', 'false', 'nao', 'no', 'off', 'inativo'].includes(normalized)) {
        return false;
    }

    return defaultValue;
}

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
        if (!res.ok || data?.error) {
            return {
                status: 'error',
                message: data?.error || `Falha ao atualizar configuracao de IA no MyZap (HTTP ${res.status}).`,
                data
            };
        }

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
