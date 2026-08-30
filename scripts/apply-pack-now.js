/**
 * Utilitário de DEV: aplica agora o melhor pack disponível (canal ou local
 * via GERENCIADOR_PACK_ZIP) na instalação REAL desta máquina, usando o mesmo
 * fluxo de update do app (staging → rename → health → rollback).
 *
 *   pnpm exec electron scripts/apply-pack-now.js
 */

const { app } = require('electron');

app.whenReady().then(async () => {
    /* eslint-disable global-require */
    const enginePack = require('../core/myzap/enginePack');
    /* eslint-enable global-require */
    try {
        const r = await enginePack.checkAndUpdatePack();
        console.log('[apply-pack] resultado:', JSON.stringify(r));
        app.exit(r?.status === 'success' || r?.status === 'up_to_date' ? 0 : 1);
    } catch (err) {
        console.error('[apply-pack] erro:', err);
        app.exit(1);
    }
});
