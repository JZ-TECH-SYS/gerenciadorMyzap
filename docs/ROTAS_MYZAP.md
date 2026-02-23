# API necessaria para integrar com o Gerenciador MyZap

Este documento define o contrato minimo da API da empresa para o `gerenciadorMyzap` funcionar (auto configuracao, polling de fila/status e sync de tokens).

## 1. Regras gerais de integracao

- Base principal: `apiUrl` salva nas configuracoes do app.
- Autenticacao: `Authorization: Bearer {apiToken}`.
- Todos os endpoints devem responder JSON.
- Regra de sucesso no app:
  - HTTP `2xx`
  - campo `error` ausente, `null` ou vazio
- Regra de falha no app:
  - HTTP fora de `2xx`, ou
  - resposta com `error` preenchido.

## 2. Endpoint de configuracao remota (obrigatorio)

O app tenta as rotas abaixo, nessa ordem, ate encontrar credenciais validas:

1. `GET /parametrizacao-myzap/config/{idempresa}`
2. `GET /parametrizacao-myzap/credenciais/{idempresa}`
3. `GET /parametrizacao-myzap/configuracao/{idempresa}`
4. `GET /parametrizacao-myzap/empresa/{idempresa}`
5. `GET /parametrizacao-myzap/{idempresa}`
6. `GET /parametrizacao-myzap/config?idempresa={idempresa}`
7. `GET /parametrizacao-myzap/credenciais?idempresa={idempresa}`
8. `GET /parametrizacao-myzap/configuracao?idempresa={idempresa}`
9. `GET /parametrizacao-myzap?idempresa={idempresa}`

Tempo limite por tentativa: `10s`.

### 2.1 Campos obrigatorios na resposta

A resposta precisa ter, em qualquer nivel do JSON, os dados logicos abaixo:

- `sessionKey`
- `myzapApiToken`

O app faz flatten recursivo do JSON, ignora maiusculas/minusculas e remove `_`, `-` e separadores.  
Exemplo: `result.config.SESSION_KEY` e aceito.

Aliases aceitos para `sessionKey`:

- `sessionkey`
- `session_key`
- `myzap_session_key`
- `myzapSessionKey`
- `session_myzap`
- `sessionmyzap`

Aliases aceitos para `myzapApiToken`:

- `apitoken`
- `api_token`
- `apiKey`
- `api_key`
- `myzap_api_token`
- `myzapApiToken`
- `sessiontoken`
- `session_token`
- `sessionToken`
- `key_myzap`
- `keymyzap`

### 2.2 Campos opcionais suportados

- `sessionName` (fallback: usa `sessionKey`)
  - aliases: `sessionname`, `session_name`, `myzap_session_name`, `myzapSessionName`, `session_myzap`, `sessionmyzap`
- Conteudo de `.env` do MyZap
  - aliases: `envcontent`, `env_content`, `myzap_env`, `myzap_env_content`, `arquivo_env`, `env`
- API/token para fila/status (se nao vier, usa `apiUrl`/`apiToken`)
  - URL aliases: `clickexpressapiurl`, `clickexpress_api_url`, `click_api_url`, `apiurlclickexpress`
  - Token aliases: `clickexpressqueuetoken`, `clickexpress_queue_token`, `clickqueuetoken`, `tokenfilaclickexpress`
- IA/prompt
  - prompt: `promptid`, `prompt_id`, `idprompt`, `myzap_prompt_id`, `myzappromptid`
  - IA ativa: `iaativa`, `ia_ativa`, `myzap_ia_ativa`, `myzapiaativa`, `iaenabled`, `ia_enabled`
- Modo de integracao (local/web)
  - aliases de modo: `modoenvio`, `modo_envio`, `modointegracao`, `modo_integracao`, `modoexecucao`, `modo_execucao`, `modomyzap`, `modo_myzap`, `tipointegracao`, `tipo_integracao`, `tipomyzap`, `tipo_myzap`, `integrationmode`, `integration_mode`, `myzapmode`, `myzap_mode`
  - aliases de modo id: `modoenvioid`, `modo_envio_id`, `modointegracaoid`, `modo_integracao_id`, `modomyzapid`, `modo_myzap_id`
  - aliases boolean local: `rodarlocal`, `rodar_local`, `executarlocal`, `executar_local`, `filalocal`, `fila_local`, `myzaplocal`, `myzap_local`

Normalizacao do modo no app:

- `1` ou palavras tipo `web`, `online`, `cloud`, `nuvem` -> `web`
- `2` ou palavras tipo `local`, `fila`, `desktop`, `onpremise` -> `local`
- default: `local`

### 2.3 Exemplo de resposta valida

```json
{
  "result": {
    "session_key": "empresa_123",
    "myzap_api_token": "tok_abc_123",
    "session_name": "empresa_123",
    "clickexpress_api_url": "https://api.suaempresa.com/",
    "clickexpress_queue_token": "bearer_fila_123",
    "modo_integracao": "local",
    "ia_ativa": true,
    "prompt_id": "42"
  }
}
```

## 3. Polling de status do MyZap

Endpoint:

- `PUT /parametrizacao-myzap/status`

Frequencia:

- a cada `10s`.

Headers:

- `Authorization: Bearer {clickexpress_queueToken}`
- `Content-Type: application/json`

Body enviado pelo app:

```json
{
  "sessionKey": "empresa_123",
  "sessionName": "empresa_123",
  "status_myzap": "ativo",
  "data_ult_verificacao": "2026-02-23 12:30:10"
}
```

Retorno minimo esperado:

```json
{
  "success": true
}
```

Observacao:

- se vier `error` no body, o app considera falha mesmo com HTTP `200`.

## 4. Polling da fila de mensagens

Endpoint:

- `GET /parametrizacao-myzap/pendentes?sessionKey={sessionKey}&sessionToken={sessionName}`

Frequencia:

- loop a cada `3s` (quando watcher de fila esta ativo).

Headers:

- `Authorization: Bearer {clickexpress_queueToken}`

Importante:

- hoje o app envia `sessionToken` com valor de `sessionName`.

Retorno esperado:

```json
{
  "result": {
    "total": 1,
    "mensagens": [
      {
        "idfila": 987,
        "idempresa": 123,
        "status": "pendente",
        "json": "{\"endpoint\":\"sendText\",\"data\":{\"number\":\"5511999999999\",\"text\":\"Ola\"}}",
        "sessionkey": "empresa_123",
        "apitoken": "tok_abc_123"
      }
    ]
  }
}
```

Campos relevantes por mensagem:

- `idfila`: obrigatorio (usado no update de status).
- `idempresa`: recomendado/esperado pelo app no callback de status.
- `json`: obrigatorio, string JSON com:
  - `endpoint` (ex: `sendText`)
  - `data` (payload para MyZap local)
- `status`: se `enviado`, mensagem e ignorada.
- `sessionkey` e `apitoken`: opcionais (sobrescrevem credenciais padrao se enviados).

## 5. Callback de status da fila

Endpoint:

- `POST /parametrizacao-myzap/fila/status`

Frequencia:

- por mensagem processada na fila.

Headers:

- `Authorization: Bearer {clickexpress_queueToken}`
- `Content-Type: application/json`

Body enviado:

```json
{
  "idfila": 987,
  "idempresa": 123,
  "status": "enviado"
}
```

`status` enviado pelo app:

- `enviado`
- `erro`

Retorno minimo esperado:

```json
{
  "success": true
}
```

## 6. Sync de tokens de IA (opcional, mas recomendado)

Esse endpoint so e usado quando:

- IA esta ativa, e
- modo de integracao esta `local`.

Endpoint:

- `POST /parametrizacao-myzap/tokens/sync`

Frequencia:

- a cada `60s`, enviando apenas delta de tokens.

Headers:

- `Authorization: Bearer {clickexpress_queueToken}`
- `Content-Type: application/json`

Body enviado:

```json
{
  "sessionKey": "empresa_123",
  "idempresa": "123",
  "tokens_total": 1200,
  "tokens_delta": 150,
  "data_sincronizacao": "2026-02-23T15:30:10.000Z"
}
```

Retorno minimo esperado:

```json
{
  "success": true
}
```

## 7. Checklist rapido de compatibilidade da API

- Existe pelo menos 1 rota de configuracao remota retornando `sessionKey` + `myzapApiToken`.
- Rotas de status/fila aceitam Bearer token e retornam JSON sem `error`.
- `GET /pendentes` retorna `result.mensagens` como array (mesmo vazio).
- `POST /fila/status` aceita `enviado` e `erro`.
- (Opcional) `POST /tokens/sync` disponivel para telemetria de IA.
