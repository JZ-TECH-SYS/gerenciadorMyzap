# Melhorias DisparaZap — worker de fila

Resumo das mudanças no worker de disparo (`core/api/whatsappQueueWatcher.js` e apoio).
Todas as alterações são **retrocompatíveis** com o backend atual.

## Arquivos alterados

| Arquivo | O que mudou |
|---------|-------------|
| `core/utils/logger.js` | Adicionado canal `backend` (`log-backend`) em `LOG_CHANNELS`. |
| `core/api/backendLogger.js` | **Novo.** Wrapper do canal `backend` (espelha `myzapLogger.js`). |
| `core/api/whatsappQueueWatcher.js` | Erro rico → API, logs estruturados/separados, delay entre itens (humanização) e auto-recover de reconexão (backoff). |

## 1) Erro rico enviado ao backend

`enviarParaMyZap()` agora retorna sempre `{ ok, erro?, codigo_http, resposta_myzap, motivo, etapa, body? }`.

`atualizarStatusFila()` recebe um 4º parâmetro opcional `detalheErro` e só incorpora os
campos extras quando `status === 'erro'`. Backends antigos ignoram os campos extras.

### Payload de `/parametrizacao-myzap/fila/status` em caso de erro

```json
{
  "idfila": 123,
  "idempresa": 1,
  "status": "erro",
  "erro": "HTTP 400",
  "motivo": "myzap_http",
  "codigo_http": 400,
  "resposta_myzap": "{...body cru do MyZap, truncado em ~2000 chars...}",
  "etapa": "envio"
}
```

Em sucesso, o body continua sendo apenas `{ idfila, idempresa, status: "enviado" }`.

### Classificação de `motivo`

| motivo | quando |
|--------|--------|
| `timeout` | `AbortError` / `ETIMEDOUT` |
| `sessao_caida` | `ECONNREFUSED` / sem resposta de rede |
| `json_parse` | corpo da fila inválido ou resposta não-JSON (HTTP < 400) |
| `myzap_http` | `res.status >= 400` ou retorno do sendText diferente de 200 |
| `numero_invalido` | corpo do MyZap indica número inexistente/sem WhatsApp |
| `myzap_validacao` | falhas de validação antes do POST (sem endpoint/sessão/token) |
| `desconhecido` | demais casos |

`etapa` é `validacao` (falhas antes do fetch) ou `envio` (resultado do POST).

## 2) Logs separados/estruturados

- Novo campo `categoria` no `metadata` (`envio | conexao | fila | erro`).
- Chamadas ao DisparaZap (`buscarPendentes`, `atualizarStatusFila`) usam o canal `backend`,
  separadas dos logs do MyZap local (canal `myzap`).
- Em erro de envio, o log usa `metadata.conteudo = <resposta crua truncada>` (renderizado
  como `<pre>` no logViewer).
- Último erro persistido no `electron-store` na chave `myzap_queueWatcherUltimoErro`
  (`{ message, etapa, timestamp }`), limpo a cada ciclo bem-sucedido. Também exposto em
  `getWhatsappQueueWatcherStatus()` como `ultimoErroDetalhe`.

## 3) Humanização (delay entre itens)

Entre itens do lote, aguarda um atraso aleatório configurável:

- `myzap_itemDelayMinMs` (default `300`)
- `myzap_itemDelayMaxMs` (default `1500`)

Não altera a trava de re-entrada nem o intervalo do loop principal (3s).

## 4) Auto-recover de reconexão

- Quando o MyZap volta a responder: `consecutiveSkips` é zerado, o backoff é limpo e a
  fila **volta a processar sozinha**, sem restart manual.
- Enquanto indisponível: backoff exponencial com teto (`BACKOFF_BASE_MS` × 2^skips, máx 60s)
  adia a próxima rodada efetiva sem parar de checar disponibilidade.
- O auto-stop após `MAX_CONSECUTIVE_SKIPS` (10) foi mantido como salvaguarda final, mas o
  fluxo agora é recuperável antes desse limite.

## Como testar manualmente

1. **Erro rico chegando ao backend**: pare o MyZap local (porta 5555) com a fila ativa e
   uma mensagem pendente. O envio falha com `motivo: "sessao_caida"`, `codigo_http: 0`, e o
   POST para `/fila/status` carrega `erro/motivo/codigo_http/resposta_myzap/etapa`.
   Verifique no canal `backend` dos logs e no backend DisparaZap.
2. **Número inválido**: forçar uma mensagem com número inexistente; conferir
   `motivo: "numero_invalido"` no payload e `metadata.conteudo` com a resposta crua.
3. **Logs separados**: abrir o logViewer e confirmar que as chamadas ao DisparaZap aparecem
   no canal `backend` e as do MyZap no canal `myzap`.
4. **Humanização**: ajustar `myzap_itemDelayMinMs`/`myzap_itemDelayMaxMs` no store e observar
   o espaçamento entre envios de um lote.
5. **Auto-recover**: derrubar o MyZap (a fila aplica backoff e loga skips); religar o MyZap e
   confirmar que a fila volta a processar sem reiniciar o app.
