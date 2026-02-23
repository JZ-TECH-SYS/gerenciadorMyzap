const Store = require('electron-store');
const getConnectionStatus = require('./getConnectionStatus');
const verifyRealStatus = require('./verifyRealStatus');
const { parseSessionPayload, mergeSessionPayloads } = require('./sessionSnapshotParser');
const { debug, warn } = require('../myzapLogger');

const store = new Store();
const LAST_QR_SNAPSHOT_KEY = 'myzap_lastQrSnapshot';
const LAST_QR_MAX_AGE_MS = 45 * 1000;

function readCachedQr() {
    const value = store.get(LAST_QR_SNAPSHOT_KEY);
    if (!value || typeof value !== 'object') return null;

    const updatedAt = Number(value.updated_at || 0);
    if (!updatedAt || (Date.now() - updatedAt) > LAST_QR_MAX_AGE_MS) {
        return null;
    }

    const qrCode = String(value.qr_code || '').trim();
    if (!qrCode) return null;

    return {
        qrCode,
        updatedAt,
        sessionStatus: String(value.session_status || '').trim().toLowerCase()
    };
}

function persistCachedQr(sessionStatus, qrCode) {
    const normalizedStatus = String(sessionStatus || '').trim().toLowerCase();
    const normalizedQr = String(qrCode || '').trim();

    if (normalizedQr) {
        store.set(LAST_QR_SNAPSHOT_KEY, {
            session_status: normalizedStatus || 'waiting_qr',
            qr_code: normalizedQr,
            updated_at: Date.now()
        });
        return;
    }

    if (['connected', 'not_found'].includes(normalizedStatus)) {
        store.delete(LAST_QR_SNAPSHOT_KEY);
    }
}

async function getSessionSnapshot() {
    let verifyPayload = null;
    let connectionPayload = null;

    try {
        verifyPayload = await verifyRealStatus();
    } catch (err) {
        warn('Falha ao obter verifyRealStatus no snapshot de sessao', {
            metadata: {
                area: 'getSessionSnapshot',
                source: 'verifyRealStatus',
                error: err?.message || String(err)
            }
        });
    }

    try {
        connectionPayload = await getConnectionStatus();
    } catch (err) {
        warn('Falha ao obter getConnectionStatus no snapshot de sessao', {
            metadata: {
                area: 'getSessionSnapshot',
                source: 'getConnectionStatus',
                error: err?.message || String(err)
            }
        });
    }

    const verifyParsed = parseSessionPayload(verifyPayload);
    const connectionParsed = parseSessionPayload(connectionPayload);
    const merged = mergeSessionPayloads(verifyParsed, connectionParsed);

    let qrCode = merged.qrCode || '';
    if (!qrCode && merged.sessionStatus === 'waiting_qr') {
        const cached = readCachedQr();
        if (cached?.qrCode) {
            qrCode = cached.qrCode;
        }
    }

    persistCachedQr(merged.sessionStatus, qrCode);

    debug('Snapshot de sessao MyZap consolidado', {
        metadata: {
            area: 'getSessionSnapshot',
            sessionStatus: merged.sessionStatus,
            hasQr: Boolean(qrCode),
            verifyStatus: verifyParsed?.status || null,
            verifyState: verifyParsed?.state || null,
            connectionStatus: connectionParsed?.status || null,
            connectionState: connectionParsed?.state || null
        }
    });

    return {
        status: 'success',
        session_status: merged.sessionStatus,
        qr_base64: qrCode || null,
        message: merged.message || null,
        sources: {
            verify: verifyParsed,
            connection: connectionParsed
        },
        raw: {
            verify: verifyPayload,
            connection: connectionPayload
        }
    };
}

module.exports = getSessionSnapshot;
