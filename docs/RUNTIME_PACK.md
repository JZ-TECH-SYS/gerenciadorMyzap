# MyZap Runtime Pack — especificação e ciclo de vida

O **Runtime Pack** é o MyZap como artefato pronto para rodar: um zip que o gerenciador extrai
e executa, sem Git, Node instalado, pnpm, rede ou compilação na máquina do cliente.

## O que vai dentro do zip (`myzap-pack-win32-x64.zip`, ~245MB)

```
manifest.json          ← identidade da instalação (o gerenciador lê ESTE arquivo no motor)
index.js, package.json ← código do MyZap (só o rastreado pelo git; sem public/, Insomnia/, docs/)
node_modules\          ← deps de PRODUÇÃO, node-linker=hoisted (pasta movível, sem junctions)
node\node.exe          ← Node.js embutido — MESMO binário/major do build (ABI do sqlite3 casado)
.puppeteer-cache\      ← Chromium do puppeteer (máquina sem Chrome também conecta)
.wwebjs_cache\         ← HTML do WhatsApp Web pré-buscado (melhor esforço)
seed\db.sqlite         ← banco-semente GERADO PELAS MIGRATIONS no build (nunca mais à mão)
```

**Dieta**: só a ENGINE=1 (whatsapp-web.js) viaja. Removidos do `package.json` do myzap por
nunca serem requeridos: wppconnect, venom, chrome-launcher, sharp, pm2, bull, request(+promise),
swagger-*, ffmpeg, file-type, form-data, package-json, pino-tee, valid-url, boxen, await-sleep,
zip-lib, assert (o builtin cobre). ~300–400MB fora do pacote. Os arquivos `engines/WppConnect.js`
e `engines/Venom.js` continuam no repo; usar ENGINE=2/3 exige reinstalar essas deps (erro claro).

### manifest.json

```json
{
  "schema": 1,
  "name": "myzap-pack",
  "version": "3.0.2",          // package.json do myzap — o número que a JZ controla
  "sha": "<commit>",
  "platform": "win32-x64",     // pack de outra plataforma é ignorado
  "nodeVersion": "22.23.1",    // major = ABI dos binários nativos (sqlite3)
  "nodeEmbedded": true,
  "chromiumEmbedded": true,
  "generatedAt": "..."
}
```

O manifest **do canal** (`myzap-pack-win32-x64.manifest.json`, asset separado) tem os mesmos
campos + `sizeBytes` e `zipSha256` (conferido após o download). O manifest **dentro do zip**
não tem os dois últimos (nasce antes da compactação) e vira o `<motor>\manifest.json` instalado —
presença dele = instalação "modo pack".

## Como nasce (build + canal)

- **Builder**: `myzap/scripts/build-pack.js`
  (`node scripts/build-pack.js [--skip-browser] [--skip-node] [--keep-work]`).
  Passos: exporta código via `git ls-files` → `pnpm install --prod` (hoisted) → **Chromium como
  passo explícito** (`node_modules/puppeteer/install.mjs` — o side-effects-cache do pnpm pulava
  o postinstall) → `sequelize-cli db:migrate` gera `seed/db.sqlite` → baixa o Node da versão
  em execução (nodejs.org) → **smoke test**: o node.exe embutido precisa carregar `sqlite3` e
  `whatsapp-web.js` → sanidade de dieta (falha se wppconnect/venom/sharp/pm2 vazarem) →
  zip via `System32\tar.exe` + manifests.
- **Canal**: workflow `myzap/.github/workflows/release-pack.yml` — dispara em **tag `v*`**
  (gate humano; push na main NUNCA publica motor). Runner windows-latest, Node 22
  (⚠️ trocar a major ali = trocar o runtime de todos os clientes).
- **Publicar**: bump `version` no package.json → commit → `git tag vX.Y.Z && git push --tags`.
  Sai em `github.com/JZ-TECH-SYS/myzap/releases` (zip + manifest).

## Como o gerenciador consome (`core/myzap/enginePack.js` + `enginePaths.js`)

**Fontes, em ordem de preferência** (a de maior versão vence):
1. **Canal**: `releases/latest/download/myzap-pack-win32-x64.manifest.json` (sem rate limit,
   sem token); zip pinado por versão em `releases/download/v<versão>/...`, sha256 conferido,
   cacheado em `myzap-packs\` (as 2 últimas versões — base do reparo offline).
2. **Local**: env `GERENCIADOR_PACK_ZIP` (dev/teste) → zip **ao lado do .exe** (pendrive) →
   `resources\myzap-pack\` (Setup FULL).
3. **Herança v2** (só como fallback do fallback): snapshot embutido antigo → ZIP da main + pnpm.

**Aplicação (troca atômica com rollback)** — `applyPackZip`:
1. Extrai em `<motor>.staging` **com o serviço no ar** (tar nativo; valida manifest +
   `node_modules/express`) — falhou aqui, nada mudou;
2. Para o serviço e espera a porta 5555 liberar de verdade;
3. Garante os dados fora do motor (ver migração abaixo);
4. `rename <motor> → <motor>.old` e `rename .staging → <motor>` (mesmo volume = atômico;
   o `.old` **é** o rollback pronto);
5. Semeia o data dir com o que faltar (`.env` do store, `seed/db.sqlite`, `.wwebjs_cache`);
6. Sobe (`<motor>\node\node.exe <motor>\index.js`, **cwd = myzap-data**) e confirma `/health`
   por até 90s;
7. Saudável ⇒ apaga `.old` e grava a versão. Falhou ⇒ **rename de volta**, religa a versão
   anterior e reporta (`rolledBack: true`). Dados nunca são tocados pela troca.

**Gatilhos**: boot (+2min) e a cada 6h (educado: adia se a fila estiver processando; retry em
15min), botão "Buscar atualização (app + MyZap)", e o degrau 3 do supervisor em modo pack =
reaplicar o pack do cache (offline). Sobras `.staging/.old/.broken` são limpas no boot.

## Layout de diretórios e migração do legado

```
%LOCALAPPDATA%\gerenciador-myzap\
├── myzap\        ← CÓDIGO (pack). Presença de manifest.json = modo pack.
├── myzap-data\   ← DADOS: .env · database\db.sqlite · instances\<sessão>\ (auth do WhatsApp)
│                    · tokens\ · userDataDir\ · .wwebjs_cache\ · logs\
└── myzap-packs\  ← cache de zips baixados
```

- O CWD do processo do MyZap é o **myzap-data** — `instances/`, `database/` e o `.env` são
  relativos ao CWD por design (patches v3 no myzap: static/EJS por `__dirname`, logs por CWD,
  `database/` criado no boot).
- **Migração v2 → v3** (uma única vez, com o serviço parado, dentro do apply): cada entrada de
  dados encontrada DENTRO do motor legado é movida por `rename` para `myzap-data\`. A sessão
  do WhatsApp não pede novo QR.
- Instalação **legada** (sem manifest): tudo continua como no v2 (dados dentro do motor,
  Electron-as-Node) até o primeiro pack ser aplicado.

## Setup LITE × FULL (CI do gerenciador)

- **LITE** (`Setup-2.3.1.exe`, 116MB): app puro. É o ÚNICO no `latest.yml` — todo auto-update
  baixa só ele. Primeiro boot sem motor: baixa o pack do canal (ou acha um local).
- **FULL** (`Setup-FULL-2.3.1.exe`, 596MB): LITE + pack em `resources\myzap-pack\` — primeira
  instalação 100% offline. Gerado por `build/full.config.js`
  (`electron-builder --config build/full.config.js --config.directories.output=dist/full`);
  o `latest.yml` desse build é descartado de propósito.
- O CI baixa o pack do canal do myzap (`gh release download`); sem release publicada, sai só
  o LITE (`continue-on-error`).

## Testes

- **E2E completo** (sandbox, não toca a instalação real):
  `pnpm exec electron scripts/test-pack-e2e.js [caminho-do-pack.zip]`
  Cenários: instalação limpa · update preservando `instances\` · rollback de pack quebrado.
- **Aplicar um pack na instalação real** (dev):
  `GERENCIADOR_PACK_ZIP=... pnpm exec electron scripts/apply-pack-now.js`

## Decisões de projeto que não são óbvias

- **Node embutido** (e não o Electron-as-Node): desacopla o ABI — o prebuild do sqlite3 casa
  com o node.exe do próprio pack para sempre; o app pode subir de Electron sem invalidar o
  motor. O Electron-as-Node ficou como fallback para instalações legadas.
- **Versão por manifest, não por SHA da main**: push no repo NUNCA vira update de cliente;
  release é decisão humana (tag). Foi exatamente a falta desse gate que quebrou clientes na v2.0.x.
- **`ON CONFLICT`/upsert exigem o usuário do sistema**: criado sob demanda
  (`controllers/helper/core/systemUser.js`) — nunca mais semente com dados mantida à mão.
- **Diagnóstico nunca é destrutivo**: `functional:false` pausa envios; `/repairSession`
  (que apaga autenticação) só por ação humana. Lição do incidente "conecta e cai" (commit
  `d2bd570` do myzap).
