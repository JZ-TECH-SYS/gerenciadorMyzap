# Gerenciador MyZap

Aplicação desktop **Electron** para gerenciamento do serviço **MyZap** — integração WhatsApp via API local com processamento de fila de mensagens pelo ClickExpress.

---

## Funcionalidades

- **Instalação automatizada** do MyZap (download do pacote oficial, instalação de dependências via runtime interno, configuração do `.env`)
- **Painel de controle** (3 abas):
  - **MyZap** — status da API, QR Code, iniciar/deletar sessão WhatsApp
  - **Status** — monitoramento em tempo real da conexão
  - **Configuração** — diretório, chaves de sessão/API, configuração do ClickExpress
- **Fila de mensagens** — visualização e controle do watcher de envio automático (integração ClickExpress)
- **Watcher de status** — envia o status da conexão ao ClickExpress a cada 10 segundos
- **Watcher de fila** — processa mensagens pendentes a cada 30 segundos
- **Visualizador de logs** — logs em tempo real com filtro por nível (info/warn/error/debug) e busca
- **Auto-update** — atualização automática via GitHub Releases (electron-updater)
- **Ícone na bandeja do sistema** com menu rápido

---

## Requisitos

Para usar o instalador do Gerenciador MyZap, nao e necessario instalar Git, Node.js ou pnpm manualmente.

Para desenvolvimento deste repositório:

- Node.js 18+
- pnpm

---

## Instalação

```bash
pnpm install
```

---

## Executar em desenvolvimento

```bash
pnpm start
```

---

## Gerar instalador

```bash
pnpm run build
```

O instalador é gerado na pasta `dist/`.

---

## Configuração

Na aplicação, acesse **Configurações** e preencha:

| Campo | Descrição |
|---|---|
| Diretório MyZap | Caminho local onde o MyZap será instalado (ex: `C:/JzTech/projects/myzap`) |
| Session Key | Chave da sessão WhatsApp |
| API Token | Token de autenticação da API MyZap |
| Conteúdo `.env` | Variáveis de ambiente do serviço MyZap |
| URL API ClickExpress | URL base da API ClickExpress |
| Token Fila ClickExpress | Bearer token para acesso à fila |

---

## Arquitetura

```
gerenciadorMyzap/
├── main.js                        # Processo principal Electron
├── core/
│   ├── api/
│   │   ├── myzapStatusWatcher.js  # Envia status ao ClickExpress (10s)
│   │   └── whatsappQueueWatcher.js # Processa fila de mensagens (30s)
│   ├── ipc/
│   │   └── myzap.js               # Todos os handlers IPC
│   ├── myzap/
│   │   ├── api/                   # Chamadas à API local MyZap (porta 5555)
│   │   ├── atualizarEnv.js        # Atualiza .env e reinicia serviço
│   │   ├── clonarRepositorio.js   # Instalação completa do MyZap
│   │   ├── iniciarMyZap.js        # Inicia serviço via pnpm
│   │   └── verificarDiretorio.js  # Verifica instalação
│   ├── utils/
│   │   └── logger.js              # Logger JSON Lines
│   ├── updater.js                 # Auto-update electron-updater
│   └── windows/                   # BrowserWindows (painel, fila, logs, tray)
├── src/loads/
│   ├── preload.js                 # Bridge renderer ↔ main (contextBridge)
│   └── preloadLog.js              # Bridge para o visualizador de logs
└── assets/
    ├── html/                      # painelMyZap · filaMyZap · logs
    ├── css/                       # Estilos dark theme
    └── js/                        # Scripts do renderer
```

---

## Tecnologias

- [Electron](https://www.electronjs.org/)
- [electron-store](https://github.com/sindresorhus/electron-store) — persistência de configurações
- [electron-updater](https://www.electron.build/auto-update) — auto-update
- [Bootstrap 5](https://getbootstrap.com/) — interface

---

## Repositório MyZap

O serviço MyZap e baixado a partir de: `https://github.com/JZ-TECH-SYS/myzap`
