# Versão Suprema — o que mudou e por quê (v2.2.0 → v2.3.1 + MyZap v3.0.2)

> Estudo completo que originou este trabalho: https://claude.ai/code/artifact/bf7618d0-3606-4738-af70-0b9ae97f301d
> Implementado, testado ponta a ponta e publicado em **30/08/2026**.

## A tese

O gerenciador v2.x tratava o MyZap como um **projeto Node a ser montado na máquina do cliente**
(clonar/baixar código, rodar `pnpm install`, torcer para rede/antivírus/toolchain colaborarem).
Cada falha desse processo virava um botão de contorno na interface.

A versão suprema troca o modelo: o MyZap agora é um **artefato pronto** (Runtime Pack) —
código + `node_modules` + Chromium + **Node.js embutido** + banco-semente, compilado e testado
no CI, publicado por tag. O gerenciador só **copia, dá spawn e vigia**. Instalar = extrair.
Atualizar = trocar pasta com rollback. (Modelo provado pelo gerenciador wuzapi, onde o ciclo
de vida inteiro cabe em ~200 linhas.)

## O que foi entregue

| Área | Antes (v2.2.0) | Agora (v2.3.1 + pack v3.0.2) |
|---|---|---|
| Instalação do motor | 3 fontes (snapshot embutido, ZIP da main + pnpm, resgates cruzados) | 1 fonte preferida: **Runtime Pack** (canal → local → herança v2 como fallback) |
| Atualização do motor | Por SHA da main + cirurgia in-place (quebrada por `hashFileSafe` inexistente); automático desligado | **Canal por tag** com gate humano; troca atômica por `rename` + **rollback automático**; religado (boot+2min, a cada 6h, botão) |
| Atualização do app | Só no boot; 530MB por release | Boot + **a cada 45min** (silencioso); **Setup LITE 116MB** no `latest.yml` |
| Instalação offline | Setup único de 530MB | **Setup FULL** (pack embutido) + suporte a pack ao lado do .exe (pendrive) |
| Dados vs código | Misturados dentro da pasta do motor (lista de preservação a cada troca) | **Separados**: `myzap\` (descartável) / `myzap-data\` (sagrado — update nunca encosta) |
| Runtime do motor | Electron do app como Node (ABI acoplado) | **node.exe do próprio pack** (sqlite3 casado no build; Electron atualiza livre) |
| Interface | 3 janelas, ~30 controles (maioria contorno de bug) | **Janela única com semáforo**: estado em 1 frase + 1 ação; ~12 controles |
| Bandeja | 10 itens | 4 (Abrir painel · Pausar/Retomar envio · Buscar atualização · Sair) |
| Conexão | "Iniciar instância" manual; QR sumia (bug de anos) | **Auto-conexão** (QR sem clique); painel abre sozinho no boot se desconectado; **reconexão automática sem QR** após reiniciar |
| Fila | Gate no start; auto-desligava em cenários | **Sempre liga** e se autogerencia (pausas recuperáveis visíveis) |
| Suporte | Painel de debug da config voltado ao cliente | **"Copiar informações para o suporte"** (diagnóstico completo no clipboard) |

## Bugs de raiz eliminados (todos verificados em produção/local)

1. **"O QR nunca aparece" (existia desde sempre em banco novo)** — `Devices.user_id` é NOT NULL
   e as engines confiavam num `User.findOne(EMAIL)` que só existia porque a antiga semente
   feita à mão embutia a linha. Banco recém-criado ⇒ todo `/start` morria em `SQLITE_CONSTRAINT`
   **antes de abrir o navegador**. Três camadas escondiam o erro: o model `User` não mapeia
   `created_at`/`updated_at` (NOT NULL) e `INSERT OR IGNORE` engole constraint em silêncio.
   Fix: `controllers/helper/core/systemUser.js` (myzap) cria o dono sob demanda via SQL explícito.
2. **`hashFileSafe` inexistente** (`updateMyZap.js:204`) — o update in-place de instalação
   válida sempre estourava `ReferenceError` DEPOIS de sobrescrever o código. Corrigido — e o
   caminho inteiro virou herança: o pack o substitui.
3. **Cadeia de migrations do myzap nunca rodava inteira** — `create-devicecompanies` datada
   *depois* das migrations que adicionam colunas nela + 3 arquivos sem timestamp + `Sequelize.fn('CURRENT_TIMESTAMP')`
   gerando SQL inválido no SQLite. Consertada; a semente agora é **gerada pelas migrations no CI**
   (morreu o `db.seed.sqlite` mantido à mão).
4. **Bypass de autorização no myzap** — `checkAPITokenMiddleware` sem `return` chamava `next()`
   com token inválido. Corrigido. (Bônus: sessionkey não vaza mais no stdout.)
5. **Checagem truthy morta na fila** (`whatsappQueueWatcher`) e **update do app só no boot**.
6. **Encerramento sujo** — o child do MyZap morria de EPIPE quando o app saía (ou ficava órfão
   segurando porta/perfil). Agora: "Sair" para o motor de propósito; e o próprio myzap ganhou
   shutdown gracioso (SIGTERM ⇒ `destroy()` dos clients).

## Arquitetura (visão de 1 tela)

```
┌────────────── CANAIS DE RELEASE ───────────────┐
│ repo myzap: tag v* ──CI──► myzap-pack.zip      │  (motor: gate humano)
│ repo gerenciador: push main ──CI──► v2.3.1     │  (app)
│   ├─ Setup LITE 116MB  ──► latest.yml (updates)│
│   └─ Setup FULL 596MB  ──► 1ª instalação/offline│
└────────────────────────────────────────────────┘
                    │
        %LOCALAPPDATA%\gerenciador-myzap\
        ├── myzap\         ← MOTOR (pack extraído; descartável)
        │   ├── manifest.json · node\node.exe · index.js · node_modules\ ...
        ├── myzap-data\    ← DADOS (update NUNCA encosta)
        │   ├── .env · database\db.sqlite · instances\<sessão>\ · logs\
        └── myzap-packs\   ← cache de packs (reparo offline)
```

Detalhes do pack, fluxo de update/rollback e migração do layout legado: **[RUNTIME_PACK.md](RUNTIME_PACK.md)**.
Operação do dia a dia, logs e troubleshooting: **[OPERACAO_E_SUPORTE.md](OPERACAO_E_SUPORTE.md)**.

## Validação (tudo executado de verdade, na máquina de dev)

- **E2E automatizado** (`scripts/test-pack-e2e.js`): **18/18 asserts** — instalação limpa do pack,
  update preservando `instances\`, e rollback automático de pack quebrado com o serviço
  voltando saudável.
- **Ciclo real**: config de 3 campos → motor instalado do pack → painel abriu sozinho →
  **QR sem nenhum clique** → escaneado → `connected` → app morto e religado →
  **reconectou sem QR** → fila drenou as mensagens pendentes do ClickExpress →
  callback `enviado` no backend.
- Releases publicadas: myzap **v3.0.2** (pack 245MB, CI 2m48s) e gerenciador **v2.3.1**
  (LITE 116MB + FULL 596MB + AppImage/deb).

## O que os clientes v2.2.0 em campo vão viver

1. Próxima checagem do updater ⇒ baixa o **LITE (116MB, não mais 530MB)** ⇒ v2.3.1.
2. No primeiro ciclo do motor (2min após boot, ou botão) ⇒ baixa o pack v3.0.2 do canal ⇒
   migra os dados para `myzap-data\` **uma única vez** (sessão preservada) ⇒ troca o motor.
3. Interface nova; a sessão do WhatsApp **não** precisa de novo QR.

## Pendências conhecidas (próximas rodadas)

- **Assinatura de código** (Azure Trusted Signing ~US$10/mês) — mata SmartScreen/Smart App Control.
- **Config v2 nos backends** (`schema: 2`, payload nomeado) — aposenta os 9 endpoints por
  adivinhação + `capabilities.js` (704 linhas). O gerenciador já está pronto para fallback.
- **Auth nas rotas abertas do myzap** (`/deleteSession`, `/health/sessions`) — exige coordenar
  headers com o gerenciador; fazer numa dupla release app+pack.
- Setup FULL pode emagrecer (o NSIS re-comprime o zip do pack sem ganho).
- `WHATSAPP_VERSION` pinada no template → mover para config remota.
- Prefetch do `.wwebjs_cache` retorna 404 (a versão pinada não existe no repo wa-version) —
  inofensivo: primeiro boot busca online uma vez.

## Lições de build que custaram horas (não repetir)

- **GNU tar do Git Bash** trata `C:\...` como `host:arquivo` — usar sempre `System32\tar.exe`.
- **extract-zip (yauzl)** rejeita as entradas `./` que o bsdtar gera ("Out of bound path") —
  no Windows, extrair pack com o tar nativo.
- **side-effects-cache do pnpm** pula o postinstall do puppeteer em reinstalações — o download
  do Chromium virou passo explícito do builder.
- **`INSERT OR IGNORE` engole violação de NOT NULL** — em tabela com colunas obrigatórias fora
  do model, inserir por SQL com todas elas explícitas.
- `resolveMyZapDirectory` rejeita pasta que ainda não existe (regra para *achar* instalação
  legada) — operações de pack usam `getEngineDir`, que confia no caminho salvo.
