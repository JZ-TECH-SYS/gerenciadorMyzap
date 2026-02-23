# Instrucoes do Copilot para Gerenciador MyZap

## Escopo do projeto

- Este repositorio e um gerenciador desktop dedicado ao modulo MyZap.
- O foco e operacao local do MyZap: setup, sessao WhatsApp, fila, status e logs.
- Nao propor fluxo de impressao ou recursos de impressora neste repositorio.

## Arquitetura principal

- Entrada do processo principal: `main.js`.
- Modulo MyZap: `core/myzap`.
- Watcher de fila WhatsApp: `core/api/whatsappQueueWatcher.js`.
- Watcher de status passivo: `core/api/myzapStatusWatcher.js`.
- IPC MyZap: `core/ipc/myzap.js`.
- Janelas: `core/windows`.
- Renderer: `assets/html`, `assets/js`, `assets/css`.
- Preload: `src/loads/preload.js`.

## Convencoes de codigo

- Use CommonJS (`require`, `module.exports`).
- Prefira `const` e `let`; finalize instrucoes com `;`.
- Mantenha mensagens e logs em portugues.
- Preserve compatibilidade Windows/Linux/macOS quando aplicavel.

## UI e IPC

- Nao acessar Node.js diretamente no renderer.
- Toda capacidade privilegiada deve passar por preload + IPC.
- Manter criacao de janelas em `core/windows`.

## Logs e erros

- Registrar erros operacionais com metadata.
- Preferir logger estruturado (`core/utils/logger.js` e `core/myzap/myzapLogger.js`).
- Nao silenciar erro sem log de warning/error.

## Release

- Build e release devem permanecer alinhados com o `package.json`.
- Evitar adicionar etapa de workflow que nao exista nos scripts npm do projeto.
