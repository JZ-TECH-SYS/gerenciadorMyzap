/**
 * Orquestrador de conexao da sessao WhatsApp com auto-recuperacao.
 *
 * Problema que resolve: as vezes o /start retorna "success" mas a sessao fica
 * ZUMBI no MyZap (estado closed/stuck) e o QR nunca aparece — a UI ficava em
 * "aguardando QR Code..." para sempre.
 *
 * connectWithRecovery():
 *   1. startSession(); se ja vier QR ou connected, retorna na hora;
 *   2. monitora o snapshot a cada 3s por ate 30s;
 *   3. nada de QR nem connected => sessao zumbi: deleteSession() + retry (1x);
 *   4. esgotou => retorna erro ACIONAVEL (a UI mostra o que fazer).
 *
 * O retry NUNCA derruba uma sessao com QR na tela: ele so dispara quando
 * nenhum QR foi gerado.
 */

const { info, warn } = require('../myzapLogger');
const startSession = require('./startSession');
const deleteSession = require('./deleteSession');
const { parseSessionPayload } = require('./sessionSnapshotParser');
const { getSessionSnapshot, clearCachedQr } = require('./getSessionSnapshot');

const ZOMBIE_QR_TIMEOUT_MS = 30 * 1000;
const MONITOR_INTERVAL_MS = 3 * 1000;
const STUCK_READS_TO_BREAK = 3;
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

async function monitorarAteQrOuConexao() {
    const inicio = Date.now();
    let stuckReads = 0;

    while (Date.now() - inicio < ZOMBIE_QR_TIMEOUT_MS) {
        await wait(MONITOR_INTERVAL_MS);

        let snap = null;
        try {
            // sem cache: decisao de zumbi precisa de dados AO VIVO
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

        if (['not_found', 'disconnected'].includes(snap?.session_status || '')) {
            stuckReads += 1;
            if (stuckReads >= STUCK_READS_TO_BREAK) {
                return null; // sessao presa, sem chance de QR
            }
        } else {
            stuckReads = 0;
        }
    }

    return null; // timeout sem QR nem conexao
}

/**
 * @param {{ forceCloseFirst?: boolean }} options
 * @returns {Promise<{ status: string, sessionStatus: string, qrCode: string|null, message: string }>}
 */
async function connectWithRecovery(options = {}) {
    const forceCloseFirst = Boolean(options.forceCloseFirst);
    const maxAttempts = 2; // tentativa normal + 1 retry pos-limpeza de zumbi

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (forceCloseFirst || attempt > 1) {
            info('connectWithRecovery: encerrando sessao atual antes de reconectar', {
                metadata: { area: 'connectSession', attempt, forceCloseFirst }
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

        const monitored = await monitorarAteQrOuConexao();
        if (monitored) {
            return monitored;
        }

        warn('connectWithRecovery: sessao sem QR e sem conexao (zumbi)', {
            metadata: { area: 'connectSession', attempt, maxAttempts }
        });
    }

    return buildResult(
        'error',
        'zombie',
        null,
        'A sessao do WhatsApp nao gerou QR Code mesmo apos reinicio automatico. Use "Forcar reconexao" ou o diagnostico do painel.'
    );
}

module.exports = { connectWithRecovery };
