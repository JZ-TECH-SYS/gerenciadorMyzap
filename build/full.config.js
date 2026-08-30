/**
 * Setup FULL — instalador de PRIMEIRA INSTALACAO 100% offline.
 *
 * Extende a config padrao (que gera o Setup LITE ~130MB, o unico que o
 * auto-update baixa via latest.yml) embutindo o MyZap Runtime Pack em
 * resources/myzap-pack/ (~250MB): no cliente, o primeiro boot instala o
 * motor SEM internet (enginePack.findLocalPack acha o zip em resources).
 *
 * O CI baixa o pack do canal do myzap para build/pack/ antes de rodar:
 *   electron-builder --win --x64 --config build/full.config.js \
 *     --config.directories.output=dist/full --publish never
 *
 * O latest.yml gerado AQUI e descartado (dist/full nao e publicado no feed);
 * apenas o .exe FULL sobe como asset avulso da release.
 */

const base = require('../package.json').build;

module.exports = {
  ...base,
  win: {
    ...base.win,
    artifactName: 'gerenciador-myzap-Setup-FULL-${version}.${ext}',
    extraResources: [
      {
        from: 'build/pack',
        to: 'myzap-pack',
        filter: ['myzap-pack-*.zip', 'myzap-pack-*.manifest.json']
      }
    ]
  }
};
