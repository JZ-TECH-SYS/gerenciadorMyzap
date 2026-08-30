# Operação e Suporte — runbook do dia a dia

## Como publicar

### Motor (MyZap) — decisão humana, sempre por tag
```bash
# no repo myzap, com a main testada:
#   1) bump "version" no package.json (ex.: 3.0.3) + commit + push
git tag v3.0.3 && git push --tags
# CI (Release Runtime Pack) publica zip+manifest em releases/ (~3 min).
# Clientes pegam no próximo ciclo (boot+2min / 6h / botão), com rollback automático.
```
⚠️ Push na main do myzap NÃO publica nada (e o deploy da VPS é manual) — só a **tag** libera motor.

### App (gerenciador) — push na main = release
```bash
# bump "version" no package.json (ex.: 2.3.2) + commit
git push origin main
# CI: Setup LITE (→ latest.yml, auto-update da frota) + Setup FULL + Linux (~10 min).
```
- Alterações só em `docs/**` ou `*.md` **não** disparam o CI (paths-ignore). Para outros commits
  que não devem publicar, use `[skip ci]` na mensagem.
- Job Linux caiu com `connection reset` baixando o Electron? É rede do GitHub:
  `gh run rerun <id> --failed` reaproveita o build Windows e destrava a release.

## Onde estão os logs

| O quê | Onde | Formato |
|---|---|---|
| Gerenciador (app) | `%TEMP%\gerenciador-myzap\logs\AAAA-MM-DD-log-{sistema,myzap,backend}.jsonl` | JSON Lines; viewer em Ajuda → técnico → "Ver registros" |
| Crash do app | `%TEMP%\jv-myzap\logs\crash.log` | síncrono, sobrevive a crash |
| Motor (MyZap) | `%LOCALAPPDATA%\gerenciador-myzap\myzap-data\logs\AAAA-MM-DD\{app,error,debug,whatsapp,database}.log` | texto; **sobrevive a update** (fica no data dir) |
| Updater do app | `%APPDATA%\gerenciador-myzap\logs\` (electron-log) | texto |

**Primeiro reflexo no suporte**: pedir para o cliente clicar **Ajuda → "Copiar informações
para o suporte"** e colar na conversa — versões, estado do serviço/sessão/fila, últimas
recuperações e último erro de envio, tudo num texto só.

## Lendo o semáforo (tela Início)

| Farol | Título típico | O que significa / o que fazer |
|---|---|---|
| ⚪ | "Preparando o MyZap… (x%)" | Instalando/atualizando o motor (~1 min). Só esperar. |
| 🟢 | "Tudo funcionando" | Serviço + WhatsApp + envio OK. Nada a fazer. |
| 🟢 | "Fora do horário de envio" | Janela de ritmo do backend; retoma sozinho no período. |
| 🟡 | "O WhatsApp não está conectado" | Botão conecta e gera QR sozinho. |
| 🟡 | "QR Code pronto — falta escanear" | WhatsApp no celular → Aparelhos conectados. |
| 🟡 | "O envio foi pausado por segurança" | Serviço oscilou no meio do lote; **retoma sozinho**, nada se perde. |
| 🟡 | "Envio pausado por você" | Switch/bandeja; botão retoma. |
| 🟡 | "O serviço local está se recuperando" | Supervisor agindo (restart→kill→reinstalar preservando dados). >5 min: "Reparar agora". |
| 🔴 | "…não está conseguindo se manter no ar" | Circuit breaker (3 recuperações/30min). Causa típica: antivírus ou disco cheio. "Resolver problemas" + investigar a máquina. |
| 🔴 | "Falta configurar o sistema" | Preencher os 3 campos (empresa/URL/token). |

## O que o sistema resolve SOZINHO (não intervir à toa)

- Serviço caiu → supervisor (health 15s): restart → kill da árvore → reinstala o motor
  **preservando a sessão** (modo pack: reaplica pack do cache, offline).
- Sessão do WhatsApp caiu → o próprio MyZap reconecta (keepalive + START_ALL_SESSIONS);
  no boot da máquina, reconecta **sem QR**.
- Fila sem credenciais/serviço/sessão → pausa recuperável visível; retoma sozinha.
- Update do motor deu errado → **rollback automático** para a versão anterior.
- Sobras de update interrompido (`.staging/.old/.broken`) → limpas no boot.
- Pico de lentidão no `/health` → tolerado (16 falhas antes de agir em processo vivo);
  reiniciar sessão à toa era o que derrubava clientes.

**Nunca** acionar `/repairSession` automaticamente (apaga a autenticação — foi o histórico
"conecta e cai"). Reparo destrutivo só por clique humano.

## Intervenções manuais (Ajuda → Opções avançadas)

| Botão | Quando usar |
|---|---|
| Reparar MyZap agora | Serviço enroscado e o semáforo não resolveu sozinho em ~5 min. Preserva a sessão. |
| Ver registros / Abrir pasta de logs | Diagnóstico. |
| Reset geral | Último recurso: apaga motor + dados + sessão (pede QR de novo). Confirmação dupla. |

Na aba WhatsApp: **Desconectar** (encerra a sessão de propósito — o app respeita e não
reconecta sozinho até você mandar) e **Forçar reconexão** (recria a sessão; pode pedir QR).

## Ferramentas de dev/QA

```bash
# E2E completo em sandbox (instala, atualiza preservando dados, prova rollback):
pnpm exec electron scripts/test-pack-e2e.js C:/caminho/myzap-pack-win32-x64.zip

# Aplicar um pack na instalação REAL desta máquina (fluxo oficial de update):
$env:GERENCIADOR_PACK_ZIP="C:\caminho\myzap-pack-win32-x64.zip"
pnpm exec electron scripts/apply-pack-now.js

# Rodar o app em dev apontando para um pack local:
$env:GERENCIADOR_PACK_ZIP="..." ; pnpm start
```

## Tabela rápida de sintomas

| Sintoma | Causa provável | Ação |
|---|---|---|
| "Preparando o MyZap" parado em % | Extração de 245MB em disco lento | Esperar ~2 min; depois disso, Reparar |
| QR não aparece após "Conectar" | v3 resolveu a causa clássica (user_id). Se ocorrer: ver `myzap-data\logs\...\error.log` | Reparar; coletar diagnóstico |
| Conectou e caiu na hora | NÃO usar reparo automático; ver `whatsapp.log` (conflito de outro aparelho? logout no celular?) | Forçar reconexão manual |
| "não está se mantendo no ar" (🔴) | Antivírus matando node/chrome; disco cheio | Exceção no AV para `%LOCALAPPDATA%\gerenciador-myzap\`; liberar disco |
| Mensagem ficou "pendente" no sistema web | Sessão desconectada ou fora da janela/teto | Semáforo diz o motivo; drena sozinho ao normalizar |
| Update do app não chega | Cliente v2.2.0 precisa reiniciar o app 1× (check era só no boot) | A partir da v2.3.1 é a cada 45min |
| SmartScreen bloqueia instalador | Sem assinatura de código (pendência conhecida) | "Mais informações → Executar assim mesmo"; assinatura no roadmap |

## Mapa de código (quem faz o quê)

- `core/myzap/enginePack.js` — canal, download+sha256, troca atômica, rollback, reparo offline.
- `core/myzap/enginePaths.js` — layout v3 (motor/data/packs) e detecção de modo.
- `core/myzap/iniciarMyZap.js` — spawn (node do pack, cwd=data) + stop com porta livre.
- `core/myzap/supervisor.js` — health 15s, escada, circuit breaker.
- `core/api/whatsappQueueWatcher.js` — fila (pausas recuperáveis, ritmo humano, erro rico).
- `core/updater.js` — update do app com fases visíveis (usadas pela UI).
- `assets/js/app.js` + `assets/html/app.html` — janela única (semáforo, auto-conexão).
- `main.js` — orquestração, tray, IPCs `app:*` (overview, diagnóstico, toggles).
- myzap: `scripts/build-pack.js` (builder) · `controllers/helper/core/systemUser.js` (dono
  das sessões) · `index.js` (graceful shutdown, database/ no boot).
