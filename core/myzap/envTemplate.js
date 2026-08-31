/**
 * Template do .env do MyZap gerado EM CODIGO (sem segredos comitados).
 *
 * Antes, um .env com TOKEN real ficava versionado em core/myzap/configs/ e
 * era copiado para todos os clientes — todo mundo compartilhava o mesmo
 * token, publico no historico do git. Agora:
 *   - o TOKEN e aleatorio POR MAQUINA (getOrCreateLocalToken);
 *   - instalacoes existentes MIGRAM sem dor: se o .env local ja tem TOKEN,
 *     ele e adotado (a sessao/integracao nao cai);
 *   - o restante do template replica o comportamento atual do MyZap.
 *
 * Campos obrigatorios pelo assert do config.js do MyZap: PORT, TOKEN,
 * CORS_ORIGIN.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { info, warn } = require('./myzapLogger');

const LOCAL_TOKEN_KEY = 'myzap_localToken';

function readTokenFromEnvFile(dirPath) {
    try {
        if (!dirPath) return '';
        const envPath = path.join(dirPath, '.env');
        if (!fs.existsSync(envPath)) return '';
        const content = fs.readFileSync(envPath, 'utf8');
        const match = content.match(/^TOKEN="?([^"\n\r]+)"?/m);
        return match && match[1] ? match[1].trim() : '';
    } catch (_e) {
        return '';
    }
}

/**
 * Token de autenticacao do MyZap local, unico por maquina.
 * Ordem: store -> .env local existente (migracao) -> aleatorio novo.
 * @param {import('electron-store')} store
 * @param {string} [installedDirPath] diretorio da instalacao p/ migracao
 */
function getOrCreateLocalToken(store, installedDirPath = '') {
    const stored = String(store.get(LOCAL_TOKEN_KEY) || '').trim();
    if (stored) {
        return stored;
    }

    const migrated = readTokenFromEnvFile(installedDirPath);
    if (migrated) {
        info('envTemplate: TOKEN existente adotado da instalacao local (migracao)', {
            metadata: { area: 'envTemplate' }
        });
        store.set(LOCAL_TOKEN_KEY, migrated);
        return migrated;
    }

    const fresh = crypto.randomBytes(24).toString('hex');
    store.set(LOCAL_TOKEN_KEY, fresh);
    info('envTemplate: TOKEN local novo gerado para esta maquina', {
        metadata: { area: 'envTemplate' }
    });
    return fresh;
}

/**
 * Monta o conteudo do .env do MyZap local.
 * @param {{ token: string, openaiKey?: string, promptId?: string, emailToken?: string }} params
 */
function buildEnvContent(params = {}) {
    const token = String(params.token || '').trim();
    const openaiKey = String(params.openaiKey || '').trim();
    // params.promptId continua aceito por compatibilidade, mas nao vai mais ao
    // .env: a variavel POMPT nunca foi lida pelo MyZap (o prompt de IA e
    // sincronizado via API /admin/ia-manager, nao via .env).
    const emailToken = String(params.emailToken || '').trim();

    if (!token) {
        warn('envTemplate: buildEnvContent chamado sem token', {
            metadata: { area: 'envTemplate' }
        });
    }

    return [
        '############################################',
        '#  .env gerado pelo Gerenciador MyZap       #',
        '#  TOKEN unico desta maquina — nao comitar  #',
        '############################################',
        '',
        '# Host of API',
        'HOST_SSL=',
        '',
        '# Server port',
        'PORT=5555',
        '',
        '# Token de protecao da API local (unico por maquina)',
        `TOKEN="${token}"`,
        '# EMAIL e a chave que liga as sessoes ao usuario dono no banco do MyZap — nao mude',
        'EMAIL="jz.tech.digital@gmail.com"',
        `OPENAI_API_KEY="${openaiKey}"`,
        'OPENAI_MODEL="gpt-4o-mini"',
        '',
        '# Atendente IA (cerebro no servico do agente — modo local zero-config):',
        '# com IA_PROVIDER=agente e SEM url/token de agente no env, o MyZap busca',
        '# a config completa em {API_CLICKEXPRESS_URL}/myzap/agente-config/{sessionkey}',
        '# (cache 10min; token compartilhado NUNCA fica em disco de lojista e pode',
        '# ser rotacionado centralmente). Requer MyZap pack >= v3.0.3; a partir do',
        '# pack v3.0.4 o toggle "Atendente IA" do painel ClickExpress (campo ia_ativa',
        '# da config remota) liga/desliga o worker local sozinho, sem tocar no banco.',
        'IA_PROVIDER=agente',
        'API_CLICKEXPRESS_URL=https://api-clickexpress.jztech.com.br/public',
        '',
        '# Version of API',
        'VERSION="latest"',
        '',
        '# Version of WhatsApp',
        '# https://wppconnect.io/pt-BR/whatsapp-versions/',
        'WHATSAPP_VERSION="2.3000.1017155554"',
        '',
        '# DEBUG_SQL=true para mostrar queries do banco no console',
        'DEBUG_SQL=false',
        '# LOG_LEVEL pode ser: DEBUG, INFO, WARNING, ERROR',
        'LOG_LEVEL=INFO',
        '',
        '# Hiden logs from database',
        'PRODUCTION=false',
        '',
        '# Engine 1 - WhatsApp-Web-JS / Engine 2 - WPPConnect / Engine 3 - Venom',
        'ENGINE=1',
        '',
        '# Default configs',
        'HTTPS=0',
        'HOST=http://127.0.0.1',
        '',
        'COMPANY="MYZAP"',
        'LOGO="https://upload.wikimedia.org/wikipedia/commons/f/f7/WhatsApp_logo.svg"',
        '',
        'CORS_ORIGIN="*"',
        'TIME_TYPING=800',
        '',
        `JWT_SECRET=${crypto.createHash('sha256').update(`jwt:${token}`).digest('hex')}`,
        '',
        '# Desabilita autenticacao 2FA do painel local (comportamento atual)',
        'DISABLE_2FA_DEV=true',
        'START_ALL_SESSIONS=true',
        'FORCE_CONNECTION_USE_HERE=true',
        '',
        '# Session keepalive job',
        'SESSION_KEEPALIVE_ENABLED=true',
        'SESSION_KEEPALIVE_INTERVAL_MS=300000',
        'SESSION_KEEPALIVE_ONLY_CONNECTED=true',
        '',
        '# Alertas por e-mail: destinatarios vazios = alertas desligados nesta maquina',
        '# (o MyZap degrada sem erro quando EMAIL_TOKEN/EMAIL_DESTINATION faltam)',
        'EMAIL_DESTINATION=""',
        'EMAIL_CC=""',
        '',
        'EMAIL_SERVICE="https://api-mail.jztech.com.br/public/"',
        `EMAIL_TOKEN="${emailToken}"`,
        '',
        'DAILY_REPORT_HOUR=8',
        'DAILY_REPORT_MINUTE=0',
        'EMAIL_SENDER_NAME=MyZap Monitor',
        ''
    ].join('\n');
}

module.exports = {
    LOCAL_TOKEN_KEY,
    getOrCreateLocalToken,
    buildEnvContent
};
