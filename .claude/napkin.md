# Napkin Runbook

## Curation Rules
- Re-prioritize on every read.
- Keep recurring, high-value notes only.
- Max 10 items per category.
- Each item includes date + "Do instead".

## Execution & Validation (Highest Priority)
1. **[2026-03-16] Bootstrap local do MyZap nao deve depender de Git ou Node globais**
   Do instead: baixar o pacote oficial do MyZap via arquivo compactado e executar o `pnpm` com o runtime do proprio app.
2. **[2026-03-16] CLI do `pnpm` empacotado precisa sobreviver ao asar**
   Do instead: manter `node_modules/pnpm/**` em `asarUnpack` e resolver o caminho com fallback para `app.asar.unpacked`.

## Shell & Command Reliability
1. **[2026-03-16] Bash do terminal integrado expande `!` em scripts inline**
   Do instead: evitar `!` em `node -e` ou montar o script com aspas que nao acionem history expansion.

## Domain Behavior Guardrails
1. **[2026-03-16] Instalacoes por arquivo compactado nao possuem `.git`**
   Do instead: tratar `git pull` como opcional e so tentar atualizar quando a pasta `.git` existir.

## User Directives
1. **[2026-03-16] O setup do gerenciador precisa ser automatico**
   Do instead: nao devolver mensagens pedindo instalacao manual de Git ou Node no fluxo padrao do MyZap.