/**
 * Orquestrador de conexao da sessao WhatsApp.
 *
 * Problema historico que este modulo agora EVITA: durante a inicializacao a
 * sessao passa por uma fase em que o MyZap responde 404/INITIALIZING nos
 * endpoints de status (o client ainda nao esta em memoria) — MESMO ja tendo
 * gerado o QR. A versao antiga interpretava isso como "sessao zumbi" e DELETAVA
 * a sessao ~9s depois do start (e o painel ainda forcava reconexao aos ~30s),
 * apagando a sessao no exato momento em que o QR aparecia. Com Chrome lento o
 * QR leva 20-40s; o delete sempre vencia a corrida e "o QR nunca aparecia".
 *
 * Comportamento atual:
 *   - O fluxo NORMAL de conectar NUNCA deleta a sessao. Ele inicia (start),
 *     aguarda um curto periodo por um QR imediato e, se ainda nao houver QR,
 *     devolve status 'initializing' (success) para o painel CONTINUAR pollando
 *     pacientemente ate o QR aparecer.
 *   - O delete (encerrar + recriar) so acontece em "Forcar reconexao" manual
 *     (forceCloseFirst), acionado pelo usuario.
 */

const { info } = require('../myzapLogger');
const startSession = require('./startSession');
const deleteSession = require('./deleteSession');
const { parseSessionPayload } = require('./sessionSnapshotParser');
const { getSessionSnapshot, clearCachedQr } = require('./getSessionSnapshot');

// Espera CURTA pelo QR logo apos o start. E so para o caso de o QR sair rapido;
// o grosso da espera fica no polling do painel (que nao bloqueia o clique). NAO
// e um timeout de "zumbi": esgotar aqui significa apenas "ainda iniciando".
const WAIT_QR_AFTER_START_MS = 12 * 1000;
const MONITOR_INTERVAL_MS = 3 * 1000;
const POS_DELETE_WAIT_MS = 3 * 1000;

function wait(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function buildResult(status, sessionStatus, qrCode, message) {
    return {
        status,
        sessionStatus,
        qrCode: qrCode || null,
        message: message || ''
    };
}

/**
 * Aguarda por ate `timeoutMs` um QR ou a conexao da sessao recem-iniciada.
 * Estados transitorios (initializing / not_found / disconnected) NAO encerram a
 * espera nem disparam delete: a sessao esta subindo e o QR pode demorar. Retorna
 * o resultado pronto se vir QR/conexao, ou null se a janela curta expirar (a
 * sessao segue viva, "iniciando").
 */
async function monitorarAteQrOuConexao(timeoutMs) {
    const inicio = Date.now();

    while (Date.now() - inicio < timeoutMs) {
        await wait(MONITOR_INTERVAL_MS);

        let snap = null;
        try {
            // sem cache: precisamos do estado AO VIVO do MyZap
            snap = await getSessionSnapshot({ allowCachedQr: false });
        } catch (_e) {
            continue;
        }

        if (snap?.session_status === 'connected') {
            return buildResult('success', 'connected', null, 'WhatsApp conectado.');
        }

        if (snap?.qr_base64) {
            return buildResult('success', 'waiting_qr', snap.qr_base64, 'Escaneie o QR Code para conectar.');
        }

        // initializing / not_found / disconnected = sessao SUBINDO. Nao desistimos
        // nem deletamos aqui — quem aguarda o tempo total e o polling do painel.
    }

    return null; // ainda sem QR dentro da janela curta; segue como "iniciando"
}

/**
 * @param {{ forceCloseFirst?: boolean }} options
 *   forceCloseFirst=true => "Forcar reconexao" manual: encerra a sessao atual
 *   antes de recriar. E o UNICO caminho que deleta a sessao.
 * @returns {Promise<{ status: string, sessionStatus: string, qrCode: string|null, message: string }>}
 */
async function connectWithRecovery(options = {}) {
    const forceCloseFirst = Boolean(options.forceCloseFirst);

    // SO no "Forcar reconexao" manual derrubamos a sessao. O fluxo normal nunca
    // deleta — era o delete automatico que apagava o QR durante a inicializacao.
    if (forceCloseFirst) {
        info('connectWithRecovery: forcando encerramento da sessao antes de reconectar', {
            metadata: { area: 'connectSession', forceCloseFirst }
        });
        try {
            await deleteSession();
        } catch (_e) { /* melhor esforco */ }
        clearCachedQr();
        await wait(POS_DELETE_WAIT_MS);
    }

    const startResp = await startSession();
    if (!startResp) {
        return buildResult(
            'error',
            'unreachable',
            null,
            'O MyZap local nao respondeu ao iniciar a sessao. O servico pode estar reiniciando — aguarde alguns segundos e tente novamente.'
        );
    }

    const parsed = parseSessionPayload(startResp);
    if (parsed.isConnected) {
        return buildResult('success', 'connected', null, 'WhatsApp conectado.');
    }
    if (parsed.qrCode) {
        return buildResult('success', 'waiting_qr', parsed.qrCode, 'Escaneie o QR Code para conectar.');
    }

    // Espera curta por um QR imediato (sessao ja quente). Se vier, otimo.
    const monitored = await monitorarAteQrOuConexao(WAIT_QR_AFTER_START_MS);
    if (monitored) {
        return monitored;
    }

    // Ainda sem QR: a sessao esta INICIANDO (Chrome carregando), nao e zumbi.
    // Devolve success/initializing para o painel CONTINUAR pollando ate o QR
    // aparecer, SEM deletar nada. Recuperacao destrutiva so via "Forcar reconexao".
    info('connectWithRecovery: sessao iniciando, QR ainda nao disponivel — painel seguira aguardando', {
        metadata: { area: 'connectSession', forceCloseFirst }
    });
    return buildResult(
        'success',
        'initializing',
        null,
        'A sessao esta iniciando (o navegador pode levar alguns segundos). Aguardando o QR Code...'
    );
}

module.exports = { connectWithRecovery };
