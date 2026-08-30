# Gerenciador MyZap

Aplicação desktop **Electron** para gerenciamento do serviço **MyZap** — integração WhatsApp via API local com processamento de fila de mensagens pelo ClickExpress.

---

## Funcionalidades

- **Instalação 100% offline** do MyZap — o instalador já traz o MyZap **pronto para rodar** (código pinado por commit + `node_modules` instalado + Chromium): o primeiro boot apenas extrai o pacote embutido, **sem internet, sem pnpm, sem scripts e sem compilação** no PC do cliente. Não precisa de Git, Node.js nem Chrome instalados. Sem o pacote embutido (build de dev), cai automaticamente no fluxo antigo de download via ZIP
- **Supervisor (watchdog)** — health-check do MyZap a cada 15s via `GET /health`; se travar, recupera sozinho em escada: restart → kill da árvore de processos → reinstalação preservando dados (a sessão do WhatsApp reconecta sozinha). Circuit breaker evita loop infinito de restart
- **Conexão com auto-recuperação** — sessão que não gera QR Code (zumbi) é encerrada e reiniciada automaticamente; erros sempre visíveis no painel com botão **Forçar reconexão**
- **Atualização do MyZap por commit** — compara o SHA da `main` no GitHub (boot + a cada 6h) e atualiza com troca atômica de diretório + rollback, preservando `.env`, banco e sessão
- **Painel de controle** (3 abas):
  - **MyZap** — status da API, QR Code, iniciar/deletar sessão WhatsApp
  - **Status** — monitoramento em tempo real da conexão
  - **Configuração** — diretório, chaves de sessão/API, configuração do ClickExpress
- **Fila de mensagens** — watcher de envio com ritmo humanizado; nunca se auto-desliga: se o MyZap cair, entra em pausa visível e **retoma sozinha** quando ele voltar
- **Watcher de status** — envia o status da conexão ao ClickExpress a cada 10 segundos
- **Visualizador de logs** — logs em tempo real com filtro por nível (info/warn/error/debug) e busca
- **Auto-update educado** — atualização via GitHub Releases que espera o fim do lote de envio antes de reiniciar o app
- **Botão "Reparar MyZap agora"** (bandeja e painel) — solução de 1 clique para o próprio cliente: reinicia o serviço na hora e, se preciso, reinstala preservando a sessão do WhatsApp
- **Auto-reparo no upgrade** — no primeiro boot de cada versão nova, o app mata processos órfãos da versão anterior, limpa estado travado e sobe limpo (instalar a versão nova já resolve os problemas da antiga)
- **Instalação por usuário (sem admin)** — instala em `%LOCALAPPDATA%`, atualizações silenciosas sem UAC; instalações antigas de Program Files recebem migração automática: o app baixa o Setup novo sozinho e oferece a troca com 1 clique
- **Segurança** — o TOKEN do MyZap local é **único por máquina** (gerado na instalação); nenhum segredo versionado no repositório
- **Ícone na bandeja do sistema** com menu rápido e notificações de recuperação/pausa

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
# 1) monta o pacote offline do MyZap (código + deps + Chromium) — o CI faz isso sozinho
pnpm run build:myzap-snapshot

# 2) gera o instalador
pnpm run build
```

O instalador é gerado na pasta `dist/`. O passo 1 é opcional em dev: sem o
snapshot, o instalador funciona no modo antigo (download do MyZap via internet
no primeiro uso). No GitHub Actions o snapshot é montado automaticamente no
runner Windows (binários nativos win32-x64 + Chromium win64 dentro do pacote).

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
│   │   ├── supervisor.js          # Watchdog: health-check + escada de recuperação
│   │   ├── opLock.js              # Mutex único do ciclo de vida (ensure/update/reset)
│   │   ├── updateChecker.js       # Compara commit SHA da main (update sem Git)
│   │   ├── updateMyZap.js         # Troca atômica de versão com rollback
│   │   ├── envTemplate.js         # .env gerado em código (TOKEN único por máquina)
│   │   ├── atualizarEnv.js        # Atualiza .env e reinicia serviço
│   │   ├── localSnapshot.js       # Instalação offline via pacote embutido no Setup
│   │   ├── clonarRepositorio.js   # Instalação completa (snapshot 1º, rede como fallback)
│   │   ├── iniciarMyZap.js        # Inicia serviço via pnpm (Node = shim do Electron)
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
