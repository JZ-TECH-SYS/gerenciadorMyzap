# Rotas e Endpoints — Modulo MyZap

Documentacao de todas as rotas HTTP usadas pelo modulo MyZap integrado ao Gerenciador de Impressao.

---

## 1. API Externa ClickExpress (baseUrl = `store.get('apiUrl')`)

Autenticacao: `Authorization: Bearer {store.get('apiToken')}`

| # | Endpoint | Metodo | Arquivo | Finalidade | Timing |
|---|----------|--------|---------|------------|--------|
| 1 | `{apiUrl}cronImpressaoDiretav3/{idempresa}` | GET | `core/api/consultarTickets.js` | Consultar tickets pendentes de impressao | Loop continuo (~500ms entre iteracoes) |

### Rotas de configuracao MyZap (tentativas em sequencia)

As rotas 2-10 sao tentadas em cadeia. O primeiro que retornar `sessionKey` + `myzapApiToken` validos e aceito.  
Timeout por requisicao: **6000ms** (`REQUEST_TIMEOUT_MS`).  
Cache: refresca apenas se ultima consulta > 5 min (`REMOTE_REFRESH_INTERVAL_MS`).

| # | Endpoint | Arquivo | Finalidade |
|---|----------|---------|------------|
| 2 | `parametrizacao-myzap/config/{idempresa}` | `core/myzap/autoConfig.js` | Rota config (path param) |
| 3 | `parametrizacao-myzap/credenciais/{idempresa}` | `core/myzap/autoConfig.js` | Rota credenciais (path param) |
| 4 | `parametrizacao-myzap/configuracao/{idempresa}` | `core/myzap/autoConfig.js` | Rota configuracao (path param) |
| 5 | `parametrizacao-myzap/empresa/{idempresa}` | `core/myzap/autoConfig.js` | Rota empresa (path param) |
| 6 | `parametrizacao-myzap/{idempresa}` | `core/myzap/autoConfig.js` | Rota raiz (path param) |
| 7 | `parametrizacao-myzap/config?idempresa={id}` | `core/myzap/autoConfig.js` | Rota config (query string) |
| 8 | `parametrizacao-myzap/credenciais?idempresa={id}` | `core/myzap/autoConfig.js` | Rota credenciais (query string) |
| 9 | `parametrizacao-myzap/configuracao?idempresa={id}` | `core/myzap/autoConfig.js` | Rota configuracao (query string) |
| 10 | `parametrizacao-myzap?idempresa={id}` | `core/myzap/autoConfig.js` | Rota raiz (query string) |

---

## 2. API ClickExpress — Fila e Status (baseUrl = `store.get('clickexpress_apiUrl')`)

Autenticacao: `Authorization: Bearer {store.get('clickexpress_queueToken')}`

| # | Endpoint | Metodo | Arquivo | Finalidade | Timing |
|---|----------|--------|---------|------------|--------|
| 11 | `parametrizacao-myzap/status` | PUT | `core/api/myzapStatusWatcher.js` | Reportar status da sessao MyZap para ClickExpress | A cada **10s** |
| 12 | `parametrizacao-myzap/pendentes?sessionKey=...&sessionToken=...` | GET | `core/api/whatsappQueueWatcher.js` | Buscar mensagens pendentes na fila WhatsApp | A cada **30s** |
| 13 | `parametrizacao-myzap/fila/status` | POST | `core/api/whatsappQueueWatcher.js` | Atualizar status de uma mensagem (enviado/erro) | Sob demanda (por mensagem) |

---

## 3. API Local MyZap (baseUrl = `http://127.0.0.1:5555/`)

Passa por `requestMyZapApi()` em `core/myzap/api/requestMyZapApi.js`.  
Headers: `Content-Type: application/json`, `apitoken`, `sessionkey`, `sessionname`.  
Timeout padrao: **8000ms**. Tenta multiplas baseUrls em sequencia (configurada + defaults).

| # | Endpoint | Metodo | Arquivo(s) | Finalidade | Timing |
|---|----------|--------|------------|------------|--------|
| 14 | `/start` | POST | `core/myzap/api/startSession.js` | Iniciar sessao WhatsApp | Sob demanda (acao do usuario) |
| 15 | `/deleteSession` | POST | `core/myzap/api/deleteSession.js` | Encerrar sessao WhatsApp | Sob demanda (acao do usuario) |
| 16 | `/getConnectionStatus` | POST | `core/myzap/api/getConnectionStatus.js` | Status de conexao da sessao | Sob demanda |
| 17 | `/verifyRealStatus` | POST | `core/myzap/api/verifyRealStatus.js` | Verificar status real (CONNECTED, QR, etc.) | Indiretamente a cada 10s e 30s |
| 18 | `/admin/ia-manager/update-config` | POST | `core/myzap/api/updateIaConfig.js` | Atualizar config de IA (mensagem padrao, prompt) | Sob demanda (acao do usuario) |
| 19 | `/{endpoint_dinamico}` | POST | `core/api/whatsappQueueWatcher.js` | Enviar mensagem WhatsApp (ex: sendText, sendImage) | Sob demanda (processamento da fila) |

---

## 4. Watchers e Intervalos

| Watcher | Arquivo | Intervalo | O que faz |
|---------|---------|-----------|-----------|
| **ticketWatcher** | `core/api/ticketWatcher.js` | Loop continuo (~500ms) | Consulta tickets de impressao |
| **myzapStatusWatcher** | `core/api/myzapStatusWatcher.js` | **10s** | Envia status MyZap para ClickExpress |
| **whatsappQueueWatcher** | `core/api/whatsappQueueWatcher.js` | **30s** | Busca pendentes + envia mensagens |
| **Remote config cache** | `core/myzap/autoConfig.js` | **5 min** | Refresca credenciais remotas |
| **Connection polling (renderer)** | `assets/js/painelMyZap.js` | **5s** | Polling de sessao/QR no painel |

---

## 5. Base URLs e Autenticacao

| Servico | Base URL | Autenticacao |
|---------|----------|--------------|
| **ClickExpress API principal** | `store.get('apiUrl')` | `Authorization: Bearer {apiToken}` |
| **ClickExpress Fila/Status** | `store.get('clickexpress_apiUrl')` | `Authorization: Bearer {clickexpress_queueToken}` |
| **MyZap Local** | `store.get('myzap_localApiUrl')` → fallback `http://127.0.0.1:5555/` → `http://localhost:5555/` | Headers: `apitoken`, `sessionkey`, `sessionname` |

---

## 6. State Machine — Estados do MyZap

O modulo usa uma state machine centralizada (`core/myzap/stateMachine.js`) com os seguintes estados:

| Estado | Descricao |
|--------|-----------|
| `idle` | Ocioso, nenhuma operacao em andamento |
| `checking_config` | Verificando configuracao remota |
| `installing_git` | Instalando Git |
| `installing_node` | Instalando Node.js |
| `cloning_repo` | Clonando repositorio MyZap |
| `installing_dependencies` | Instalando dependencias (pnpm install) |
| `starting_service` | Iniciando servico MyZap |
| `running` | MyZap rodando normalmente |
| `error` | Estado de erro |
| `resetting` | Resetando ambiente local |

Transicoes sao emitidas via IPC push (`myzap:state-changed`) para todos os renderers.
