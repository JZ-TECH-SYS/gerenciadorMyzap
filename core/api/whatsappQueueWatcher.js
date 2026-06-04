const Store = require('electron-store');
const { info, warn, error, debug } = require('../myzap/myzapLogger');
// Canal 'backend' dedicado para as chamadas ao DisparaZap (pendentes / fila/status).
const backendLog = require('./backendLogger');
const {
  isCapabilityEnabled,
  getCapabilityEntry,
  getBackendApiConfig
} = require('../myzap/capabilities');

const store = new Store();
const MYZAP_API_URL = 'http://localhost:5555/';
const LOOP_INTERVAL_MS = 3000;
const FETCH_TIMEOUT_MS = 15000;
const PROCESSANDO_TIMEOUT_MS = 120000;

// Limite de caracteres da resposta crua do MyZap enviada ao backend / logada.
const MAX_RESPOSTA_MYZAP_CHARS = 2000;

// Humanizacao: delay aleatorio (ms) entre itens do lote. Configuravel via store.
const DEFAULT_ITEM_DELAY_MIN_MS = 300;
const DEFAULT_ITEM_DELAY_MAX_MS = 1500;

// Reconexao: backoff simples enquanto o MyZap estiver indisponivel.
const BACKOFF_BASE_MS = LOOP_INTERVAL_MS;
const BACKOFF_MAX_MS = 30000;

// Chave no electron-store para persistir o ultimo erro de envio/ciclo.
const STORE_ULTIMO_ERRO_KEY = 'myzap_queueWatcherUltimoErro';

// Proxima rodada de processamento so volta a acontecer apos esse timestamp (backoff).
let backoffAteEm = 0;

function clampNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function getItemDelayConfig() {
  // Teto de seguranca: mesmo com config alta, o atraso por item fica limitado
  // para o ciclo nao se aproximar do PROCESSANDO_TIMEOUT_MS em lotes grandes.
  const TETO_MS = 8000;
  let min = clampNumber(store.get('myzap_itemDelayMinMs'), DEFAULT_ITEM_DELAY_MIN_MS);
  let max = clampNumber(store.get('myzap_itemDelayMaxMs'), DEFAULT_ITEM_DELAY_MAX_MS);
  min = Math.min(min, TETO_MS);
  max = Math.min(max, TETO_MS);
  if (max < min) max = min;
  return { min, max };
}

function randomDelayMs() {
  const { min, max } = getItemDelayConfig();
  return Math.floor(min + Math.random() * (max - min));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Trunca a resposta crua do MyZap (objeto ou string) para ~2000 chars. */
function truncarResposta(resposta) {
  if (resposta === undefined || resposta === null) return '';
  let texto;
  if (typeof resposta === 'string') {
    texto = resposta;
  } else {
    try {
      texto = JSON.stringify(resposta);
    } catch {
      texto = String(resposta);
    }
  }
  if (texto.length > MAX_RESPOSTA_MYZAP_CHARS) {
    return `${texto.slice(0, MAX_RESPOSTA_MYZAP_CHARS)}...[truncado]`;
  }
  return texto;
}

/**
 * Aplica backoff exponencial simples (com teto) para a proxima rodada efetiva,
 * com base na quantidade de skips consecutivos. O loop continua rodando a cada
 * 3s, mas o ciclo so volta a processar/checar apos a janela de backoff expirar
 * (recuperacao com latencia de ate BACKOFF_MAX_MS).
 */
function aplicarBackoff() {
  const fator = Math.min(consecutiveSkips, 6); // limita o expoente
  const atraso = Math.min(BACKOFF_BASE_MS * Math.pow(2, fator), BACKOFF_MAX_MS);
  backoffAteEm = Date.now() + atraso;
  return atraso;
}

/** Limpa o backoff quando o MyZap volta a responder. */
function limparBackoff() {
  backoffAteEm = 0;
}

/** Persiste o ultimo erro no electron-store (limpo no ciclo bem-sucedido). */
function setUltimoErroStore(detalhe) {
  try {
    if (!detalhe) {
      store.delete(STORE_ULTIMO_ERRO_KEY);
      return;
    }
    store.set(STORE_ULTIMO_ERRO_KEY, {
      message: detalhe.message || '',
      etapa: detalhe.etapa || '',
      timestamp: new Date().toISOString()
    });
  } catch {
    /* store indisponivel: ignora */
  }
}

let ativo = false;
let processando = false;
let processandoDesde = 0;
let timer = null;
let ultimaExecucaoEm = null;
let ultimoErro = null;
let ultimoLote = 0;
let ultimosPendentes = [];
let consecutiveSkips = 0;
const MAX_CONSECUTIVE_SKIPS = 10;
const SKIP_LOG_EVERY = 5;

function normalizeBaseUrl(url) {
  if (!url || typeof url !== 'string') return '';
  return url.endsWith('/') ? url : `${url}/`;
}

function supportsQueuePolling() {
  return isCapabilityEnabled('supportsQueuePolling', store);
}

async function validarDisponibilidadeMyZap(sessionKey, sessionToken) {
  try {
    debug('[FilaMyZap] Validando disponibilidade do MyZap (/verifyRealStatus)...', {
      metadata: { sessionKey }
    });

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(`${MYZAP_API_URL}verifyRealStatus`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apitoken: sessionToken,
        sessionkey: sessionKey
      },
      body: JSON.stringify({ session: sessionKey }),
      signal: ctrl.signal
    });

    clearTimeout(timeout);

    const data = await res.json().catch(() => ({}));
    debug('[FilaMyZap] Retorno verifyRealStatus', { metadata: { status: res.status, data } });
    // Diferencia credencial/sessao invalida (401/403) de MyZap offline: o sintoma
    // e o mesmo (res.ok=false), mas a causa e a sessao/token, nao a conexao — sem
    // isso o operador ve "MyZap indisponivel" quando o real e credencial expirada.
    if (res.status === 401 || res.status === 403) {
      warn('[FilaMyZap] Credencial/sessao invalida no MyZap (verifique session/token, nao e queda de conexao)', {
        metadata: { categoria: 'conexao', codigo_http: res.status }
      });
    }
    return res.ok;
  } catch (err) {
    warn('[FilaMyZap] Erro ao validar disponibilidade do MyZap', {
      metadata: { error: err?.message || err }
    });
    return false;
  }
}

async function buscarPendentes(apiBaseUrl, token, sessionKey, sessionName, idempresa = '') {
  const params = new URLSearchParams({
    sessionKey: sessionKey || '',
    sessionToken: sessionName || ''
  });

  if (idempresa) {
    params.set('idempresa', idempresa);
  }

  const query = params.toString();

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  // Log no canal 'backend' (chamada ao DisparaZap, nao ao MyZap local).
  backendLog.debug('[Backend] Buscando pendentes', {
    metadata: {
      categoria: 'fila',
      apiBaseUrl,
      sessionKey,
      sessionName,
      idempresa: idempresa || null,
      query
    }
  });
  const res = await fetch(`${apiBaseUrl}parametrizacao-myzap/pendentes?${query}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    signal: ctrl.signal
  });

  clearTimeout(timeout);

  const data = await res.json().catch(() => ({}));
  backendLog.debug('[Backend] Retorno /parametrizacao-myzap/pendentes', {
    metadata: {
      categoria: 'fila',
      status: res.status,
      total: data?.result?.total,
      error: data?.error
    }
  });
  if (!res.ok || data?.error) {
    throw new Error(data?.error || 'Falha ao consultar pendentes');
  }

  return Array.isArray(data?.result?.mensagens) ? data.result.mensagens : [];
}

/**
 * Envia o status da fila ao backend.
 * - `payload` contem os campos base sempre enviados: { idfila, idempresa, status }.
 * - `detalheErro` (opcional) so e incorporado quando status === 'erro', de forma
 *   RETROCOMPATIVEL: backends antigos ignoram os campos extras.
 */
async function atualizarStatusFila(apiBaseUrl, token, payload, detalheErro = null) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  // Monta o body final. Campos base inalterados; extras apenas em erro.
  let body = { ...payload };
  if (String(payload?.status || '').toLowerCase() === 'erro' && detalheErro) {
    body = {
      ...body,
      erro: detalheErro.erro || '',
      motivo: detalheErro.motivo || 'desconhecido',
      codigo_http: Number.isFinite(detalheErro.codigo_http) ? detalheErro.codigo_http : 0,
      resposta_myzap: truncarResposta(detalheErro.resposta_myzap),
      etapa: detalheErro.etapa || 'envio'
    };
  }

  backendLog.debug('[Backend] Atualizando status da fila', {
    metadata: { categoria: 'fila', ...body }
  });
  const res = await fetch(`${apiBaseUrl}parametrizacao-myzap/fila/status`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body),
    signal: ctrl.signal
  });

  clearTimeout(timeout);

  const data = await res.json().catch(() => ({}));
  backendLog.debug('[Backend] Retorno /parametrizacao-myzap/fila/status', {
    metadata: { categoria: 'fila', status: res.status, data }
  });
  return res.ok && !data?.error;
}

/**
 * Heuristica simples: detecta na resposta do MyZap indicacao de numero invalido
 * (ex.: "number does not exist", "numero invalido", "not on whatsapp").
 */
function pareceNumeroInvalido(body) {
  const txt = String(body?.error || body?.message || body?.result || '').toLowerCase();
  if (!txt) return false;
  // Exclui erros de sessao/credencial/payload, que NAO sao do numero do destinatario.
  if (/(session|sess[aã]o|token|apitoken|api token|parameter|par[aâ]metro|credential|credencial|unauthorized|n[aã]o autorizad|forbidden)/.test(txt)) {
    return false;
  }
  const temContextoNumero = /(n[uú]mero|number|phone|telefone|whatsapp|destinat)/.test(txt);
  const temInexistencia = /(does not exist|not exist|n[aã]o existe|nao existe|not on whatsapp|sem whatsapp|invalid number|n[uú]mero inv[aá]lid|invalid wa|not a valid|nao e um numero|n[aã]o registrad)/.test(txt);
  return temContextoNumero && temInexistencia;
}

/**
 * Extrai o id real da mensagem no WhatsApp da resposta do /sendText do MyZap.
 * Cobre os 3 formatos das engines: whatsapp-web.js (body.id), WppConnect
 * (body.data.id[._serialized]) e Venom (body.messageId). Vazio se nao achar.
 * Esse id e o que casa com o ACK (entregue/lido) la no DisparaZap.
 */
function extrairMessageId(body) {
  if (!body || typeof body !== 'object') {
    return '';
  }
  const cand =
    body.messageId ||
    body.id ||
    (body.data && (body.data.id || body.data.messageId)) ||
    (body.data && body.data.message && body.data.message.id) ||
    '';
  if (!cand) {
    return '';
  }
  if (typeof cand === 'string') {
    return cand.trim();
  }
  if (typeof cand === 'object' && cand._serialized) {
    return String(cand._serialized).trim();
  }
  return String(cand).trim();
}

/**
 * Envia a mensagem para o MyZap local.
 * Retorna SEMPRE: { ok, erro?, skipped?, body?, codigo_http, resposta_myzap, motivo, etapa }
 * - etapa: 'validacao' (falhas antes do fetch) ou 'envio' (resultado do POST).
 * - motivo: timeout | json_parse | myzap_http | numero_invalido | sessao_caida | myzap_validacao | desconhecido.
 */
async function enviarParaMyZap(mensagem, fallbackSessionKey, fallbackApiToken) {
  if (String(mensagem?.status || '').toLowerCase() === 'enviado') {
    return { ok: true, skipped: true, motivo: 'status_enviado' };
  }

  // --- Etapa de validacao (antes de tocar no MyZap) ---
  let payloadFila = {};
  try {
    payloadFila = mensagem?.json ? JSON.parse(mensagem.json) : {};
  } catch (e) {
    return {
      ok: false,
      erro: `JSON invalido da fila: ${e.message}`,
      codigo_http: 0,
      resposta_myzap: '',
      motivo: 'json_parse',
      etapa: 'validacao'
    };
  }

  const endpoint = payloadFila?.endpoint;
  const data = payloadFila?.data;

  if (!endpoint || !data) {
    return {
      ok: false,
      erro: 'Mensagem sem endpoint ou payload para MyZap',
      codigo_http: 0,
      resposta_myzap: '',
      motivo: 'myzap_validacao',
      etapa: 'validacao'
    };
  }

  const endpointNormalizado = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
  const sessionKey = mensagem?.sessionkey || fallbackSessionKey;
  const apiToken = mensagem?.apitoken || fallbackApiToken;

  if (!sessionKey || !apiToken) {
    return {
      ok: false,
      erro: 'SessionKey ou APIToken do MyZap ausente',
      codigo_http: 0,
      resposta_myzap: '',
      motivo: 'myzap_validacao',
      etapa: 'validacao'
    };
  }

  debug('[FilaMyZap] Enviando para MyZap', {
    metadata: {
      categoria: 'envio',
      idfila: mensagem?.idfila,
      endpoint: endpointNormalizado,
      sessionKey
    }
  });

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  // --- Etapa de envio (POST ao MyZap) ---
  let res;
  try {
    res = await fetch(`${MYZAP_API_URL}${endpointNormalizado}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apitoken: apiToken,
        sessionkey: sessionKey
      },
      body: JSON.stringify(data),
      signal: ctrl.signal
    });
  } catch (err) {
    clearTimeout(timeout);
    // Sem resposta HTTP: timeout (abort) ou MyZap fora do ar (conexao recusada).
    const isTimeout = err?.name === 'AbortError' || err?.code === 'ETIMEDOUT';
    const isConnDown = err?.code === 'ECONNREFUSED' || /ECONNREFUSED|ECONNRESET|fetch failed|network/i.test(err?.message || '');
    const motivo = isTimeout ? 'timeout' : (isConnDown ? 'sessao_caida' : 'desconhecido');
    return {
      ok: false,
      erro: err?.message || 'Falha de conexao com o MyZap',
      codigo_http: 0,
      resposta_myzap: '',
      motivo,
      etapa: 'envio'
    };
  }

  clearTimeout(timeout);

  // Corpo cru do MyZap. Se nao for JSON valido, classifica como json_parse.
  let body = {};
  let jsonParseFalhou = false;
  try {
    body = await res.json();
  } catch {
    jsonParseFalhou = true;
    body = {};
  }

  debug('[FilaMyZap] Retorno MyZap', {
    metadata: {
      categoria: 'envio',
      idfila: mensagem?.idfila,
      status: res.status,
      body
    }
  });

  if (jsonParseFalhou) {
    return {
      ok: false,
      erro: `Resposta nao-JSON do MyZap (HTTP ${res.status})`,
      codigo_http: res.status,
      resposta_myzap: '',
      motivo: res.status >= 400 ? 'myzap_http' : 'json_parse',
      etapa: 'envio'
    };
  }

  if (!res.ok || body?.error) {
    const motivo = pareceNumeroInvalido(body)
      ? 'numero_invalido'
      : (res.status >= 400 ? 'myzap_http' : 'desconhecido');
    return {
      ok: false,
      erro: body?.error || `HTTP ${res.status}`,
      codigo_http: res.status,
      resposta_myzap: body,
      motivo,
      etapa: 'envio'
    };
  }

  if (endpointNormalizado.toLowerCase() === 'sendtext' && body?.result !== 200) {
    return {
      ok: false,
      erro: 'Retorno do sendText diferente de 200',
      codigo_http: res.status,
      resposta_myzap: body,
      motivo: 'myzap_http',
      etapa: 'envio'
    };
  }

  return { ok: true, body, codigo_http: res.status, resposta_myzap: body, motivo: 'ok', etapa: 'envio' };
}

async function obterCredenciaisAtivas() {
  const {
    backendApiUrl,
    backendApiToken
  } = getBackendApiConfig(store);
  const sessionKey = String(store.get('myzap_sessionKey') || '').trim();
  const sessionName = String(store.get('myzap_sessionName') || sessionKey).trim();
  const myzapApiToken = String(store.get('myzap_apiToken') || '').trim();
  const idempresa = String(store.get('idempresa') || '').trim();

  return {
    backendApiUrl: normalizeBaseUrl(backendApiUrl),
    backendApiToken,
    sessionKey,
    sessionName,
    myzapApiToken,
    idempresa
  };
}

async function listarPendentesMyZap() {
  const config = await obterCredenciaisAtivas();
  const {
    backendApiUrl,
    backendApiToken,
    sessionKey,
    sessionName,
    idempresa
  } = config;

  if (!backendApiUrl || !backendApiToken || !sessionKey || !sessionName) {
    return [];
  }

  return buscarPendentes(backendApiUrl, backendApiToken, sessionKey, sessionName, idempresa);
}

async function processarFilaUmaRodada() {
  if (!ativo) return;

  if (!supportsQueuePolling()) {
    info('[FilaMyZap] Watcher interrompido porque a capability foi desabilitada', {
      metadata: { area: 'whatsappQueueWatcher' }
    });
    stopWhatsappQueueWatcher();
    return;
  }

  // Protecao contra processamento travado (timeout de seguranca)
  if (processando) {
    const elapsed = Date.now() - processandoDesde;
    if (elapsed > PROCESSANDO_TIMEOUT_MS) {
      warn('[FilaMyZap] Processamento anterior travado, resetando flag processando', {
        metadata: { area: 'whatsappQueueWatcher', elapsedMs: elapsed }
      });
      processando = false;
    } else {
      return;
    }
  }

  // Backoff de reconexao: enquanto o MyZap esteve indisponivel, espacamos as
  // tentativas para nao acumular skips rapido demais (evita o auto-stop). Durante
  // a janela de backoff o ciclo NAO checa disponibilidade; a recuperacao tem
  // latencia de ate BACKOFF_MAX_MS apos o MyZap voltar.
  if (backoffAteEm && Date.now() < backoffAteEm) {
    return;
  }

  processando = true;
  processandoDesde = Date.now();

  info('[FilaMyZap] Iniciando ciclo de processamento da fila', {
    metadata: { area: 'whatsappQueueWatcher' }
  });

  try {
    // Validar MyZap disponivel antes de buscar pendentes
    const configAtual = await obterCredenciaisAtivas();
    if (!configAtual.sessionKey || !configAtual.myzapApiToken) {
      consecutiveSkips++;
      const atraso = aplicarBackoff();
      if (consecutiveSkips % SKIP_LOG_EVERY === 1) {
        warn(`[FilaMyZap] Credenciais ausentes (skip #${consecutiveSkips}, backoff ${atraso}ms)`, {
          metadata: { categoria: 'conexao', consecutiveSkips, backoffMs: atraso }
        });
      }
      // Auto-stop apenas como salvaguarda final; continua recuperavel se as
      // credenciais voltarem antes do limite.
      if (consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) {
        warn(`[FilaMyZap] Auto-stop: ${MAX_CONSECUTIVE_SKIPS} skips consecutivos`, {
          metadata: { categoria: 'conexao', area: 'whatsappQueueWatcher' }
        });
        stopWhatsappQueueWatcher();
      }
      return;
    }

    const myzapOk = await validarDisponibilidadeMyZap(configAtual.sessionKey, configAtual.myzapApiToken);
    if (!myzapOk) {
      consecutiveSkips++;
      const atraso = aplicarBackoff();
      if (consecutiveSkips % SKIP_LOG_EVERY === 1) {
        warn(`[FilaMyZap] MyZap indisponivel (skip #${consecutiveSkips}, backoff ${atraso}ms)`, {
          metadata: { categoria: 'conexao', consecutiveSkips, backoffMs: atraso }
        });
      }
      if (consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) {
        warn(`[FilaMyZap] Auto-stop: ${MAX_CONSECUTIVE_SKIPS} skips consecutivos (MyZap down)`, {
          metadata: { categoria: 'conexao', area: 'whatsappQueueWatcher' }
        });
        stopWhatsappQueueWatcher();
      }
      return;
    }

    // MyZap ok: reset do contador de skips e do backoff -> a fila volta a
    // processar sozinha assim que o MyZap responder, sem restart manual.
    if (consecutiveSkips > 0) {
      info('[FilaMyZap] MyZap disponivel novamente, retomando processamento', {
        metadata: { categoria: 'conexao', skipsAnteriores: consecutiveSkips }
      });
    }
    consecutiveSkips = 0;
    limparBackoff();

    const pendentes = await listarPendentesMyZap();
    ultimosPendentes = Array.isArray(pendentes) ? pendentes : [];
    const lote = pendentes.filter((m) => String(m?.status || '').toLowerCase() !== 'enviado');

    ultimoLote = lote.length;
    ultimaExecucaoEm = new Date().toISOString();

    info('[FilaMyZap] Busca de pendentes concluida', {
      metadata: { totalPendentes: pendentes.length, tamanhoLote: lote.length }
    });

    if (lote.length === 0) {
      info('[FilaMyZap] Nenhuma mensagem pendente para envio neste ciclo', {
        metadata: { area: 'whatsappQueueWatcher' }
      });
    }

    const {
      backendApiUrl,
      backendApiToken,
      sessionKey,
      myzapApiToken,
      idempresa
    } = await obterCredenciaisAtivas();

    for (let i = 0; i < lote.length; i++) {
      const mensagem = lote[i];
      if (!ativo) break;

      // Salvaguarda: nao deixa o ciclo ultrapassar o timeout de re-entrada
      // (PROCESSANDO_TIMEOUT_MS). Sem isso, o delay de humanizacao em lotes
      // grandes poderia abrir um 2o ciclo concorrente -> reenvio duplicado.
      // Deixa margem de um FETCH_TIMEOUT para o item em voo terminar.
      if (Date.now() - processandoDesde > PROCESSANDO_TIMEOUT_MS - FETCH_TIMEOUT_MS) {
        warn('[FilaMyZap] Ciclo perto do timeout: pausando o lote (restante segue no proximo ciclo)', {
          metadata: { categoria: 'fila', processados: i, restante: lote.length - i }
        });
        break;
      }

      let novoStatus = 'erro';
      // Detalhe rico enviado ao backend apenas em caso de erro (retrocompativel).
      let detalheErro = null;
      // id real da msg no WhatsApp (so no sucesso) -> reportado p/ casar com o ACK.
      let messageId = '';
      try {
        info('[FilaMyZap] Enviando mensagem', {
          metadata: { categoria: 'envio', idfila: mensagem?.idfila, idempresa: mensagem?.idempresa }
        });

        const envio = await enviarParaMyZap(mensagem, sessionKey, myzapApiToken);
        novoStatus = envio.ok ? 'enviado' : 'erro';

        if (envio.ok) {
          messageId = extrairMessageId(envio.body);
          info('[FilaMyZap] Mensagem enviada com sucesso', {
            metadata: { categoria: 'envio', idfila: mensagem?.idfila, idempresa: mensagem?.idempresa, messageId }
          });
        } else {
          // Monta o detalhe do erro para o backend e para o log estruturado.
          detalheErro = {
            erro: envio?.erro || 'Falha no envio',
            motivo: envio?.motivo || 'desconhecido',
            codigo_http: Number.isFinite(envio?.codigo_http) ? envio.codigo_http : 0,
            resposta_myzap: envio?.resposta_myzap ?? '',
            etapa: envio?.etapa || 'envio'
          };
          // metadata.conteudo (string) e renderizado como <pre> no logViewer.
          warn('[FilaMyZap] Falha ao enviar mensagem para MyZap', {
            metadata: {
              categoria: 'erro',
              idfila: mensagem?.idfila,
              idempresa: mensagem?.idempresa,
              motivo: detalheErro.motivo,
              codigo_http: detalheErro.codigo_http,
              etapa: detalheErro.etapa,
              erro: detalheErro.erro,
              conteudo: truncarResposta(detalheErro.resposta_myzap)
            }
          });
          setUltimoErroStore({ message: detalheErro.erro, etapa: detalheErro.etapa });
        }
      } catch (envioError) {
        // Excecao inesperada (fora do fluxo previsto de enviarParaMyZap).
        detalheErro = {
          erro: envioError?.message || String(envioError),
          motivo: 'desconhecido',
          codigo_http: 0,
          resposta_myzap: '',
          etapa: 'envio'
        };
        warn('Erro inesperado no envio para MyZap', {
          metadata: {
            categoria: 'erro',
            idfila: mensagem?.idfila,
            idempresa: mensagem?.idempresa,
            error: envioError
          }
        });
        setUltimoErroStore({ message: detalheErro.erro, etapa: detalheErro.etapa });
      }

      const payloadStatus = {
        idfila: mensagem?.idfila,
        idempresa: mensagem?.idempresa || idempresa,
        status: novoStatus
      };
      // So no sucesso e quando o MyZap devolveu o id: backend grava p/ casar o ACK.
      if (novoStatus === 'enviado' && messageId) {
        payloadStatus.message_id = messageId;
      }

      const statusOk = await atualizarStatusFila(
        backendApiUrl,
        backendApiToken,
        payloadStatus,
        detalheErro
      );

      if (!statusOk) {
        warn('Nao foi possivel atualizar status da fila MyZap', {
          metadata: {
            categoria: 'fila',
            idfila: mensagem?.idfila,
            idempresa: mensagem?.idempresa,
            status: novoStatus
          }
        });
      }

      // Humanizacao: pequeno atraso aleatorio ANTES do proximo item do lote.
      // Nao altera a trava de re-entrada nem o intervalo do loop principal.
      if (ativo && i < lote.length - 1) {
        await sleep(randomDelayMs());
      }
    }

    info('[FilaMyZap] Ciclo de processamento concluido', {
      metadata: { categoria: 'fila', area: 'whatsappQueueWatcher', loteProcessado: lote.length }
    });

    // Ciclo sem erro de ciclo: limpa o ultimo erro persistido.
    ultimoErro = null;
    setUltimoErroStore(null);
  } catch (e) {
    ultimoErro = e?.message || String(e);
    error('Erro no watcher da fila MyZap', {
      metadata: { categoria: 'erro', area: 'whatsappQueueWatcher', error: e }
    });
    setUltimoErroStore({ message: ultimoErro, etapa: 'ciclo' });
  } finally {
    processando = false;
  }
}

async function startWhatsappQueueWatcher() {
  if (ativo) {
    return { status: 'success', message: 'Watcher da fila MyZap ja esta em execucao.' };
  }

  if (!supportsQueuePolling()) {
    info('[FilaMyZap] Watcher ignorado por capability desabilitada', {
      metadata: {
        area: 'whatsappQueueWatcher',
        capability: getCapabilityEntry('supportsQueuePolling', store)
      }
    });
    return {
      status: 'skipped',
      message: 'Watcher da fila ignorado: recurso nao suportado ou desabilitado.'
    };
  }

  const config = await obterCredenciaisAtivas();
  if (!config.backendApiUrl || !config.backendApiToken || !config.sessionKey || !config.myzapApiToken) {
    warn('[FilaMyZap] Configuracao incompleta para iniciar watcher', {
      metadata: {
        backendApiUrl: !!config.backendApiUrl,
        backendApiToken: !!config.backendApiToken,
        sessionKey: !!config.sessionKey,
        sessionName: !!config.sessionName,
        myzapApiToken: !!config.myzapApiToken
      }
    });
    return { status: 'error', message: 'Configuracao do backend/MyZap incompleta.' };
  }

  const myzapDisponivel = await validarDisponibilidadeMyZap(config.sessionKey, config.myzapApiToken);
  if (!myzapDisponivel) {
    return {
      status: 'error',
      message: 'MyZap indisponivel. Verifique se a sessao esta ativa antes de iniciar a fila.'
    };
  }

  ativo = true;
  ultimoErro = null;

  info('Iniciando watcher da fila MyZap', {
    metadata: { area: 'whatsappQueueWatcher', loopMs: LOOP_INTERVAL_MS }
  });

  timer = setInterval(() => {
    debug('[FilaMyZap] Tick de processamento da fila');
    processarFilaUmaRodada().catch((err) => {
      error('Erro inesperado no loop da fila MyZap', {
        metadata: { area: 'whatsappQueueWatcher', error: err }
      });
    });
  }, LOOP_INTERVAL_MS);

  await processarFilaUmaRodada();
  return { status: 'success', message: 'Watcher da fila MyZap iniciado com sucesso.' };
}

function stopWhatsappQueueWatcher() {
  if (!ativo && !timer) {
    return { status: 'success', message: 'Watcher da fila MyZap ja estava parado.' };
  }

  if (timer) {
    clearInterval(timer);
    timer = null;
  }

  ativo = false;
  processando = false;

  info('Watcher da fila MyZap parado', {
    metadata: { area: 'whatsappQueueWatcher' }
  });

  return { status: 'success', message: 'Watcher da fila MyZap parado com sucesso.' };
}

function getWhatsappQueueWatcherStatus() {
  const proximaExecucaoEm = ultimaExecucaoEm
    ? new Date(new Date(ultimaExecucaoEm).getTime() + LOOP_INTERVAL_MS).toISOString()
    : null;

  return {
    ativo,
    capabilityEnabled: supportsQueuePolling(),
    processando,
    ultimoLote,
    ultimaExecucaoEm,
    proximaExecucaoEm,
    loopIntervalMs: LOOP_INTERVAL_MS,
    ultimoErro,
    // Ultimo erro persistido (sobrevive entre reinicios): { message, etapa, timestamp }.
    ultimoErroDetalhe: store.get(STORE_ULTIMO_ERRO_KEY) || null,
    backoffAteEm: backoffAteEm || null,
    consecutiveSkips
  };
}

function getUltimosPendentesMyZap() {
  return Array.isArray(ultimosPendentes) ? [...ultimosPendentes] : [];
}

module.exports = {
  listarPendentesMyZap,
  getUltimosPendentesMyZap,
  startWhatsappQueueWatcher,
  stopWhatsappQueueWatcher,
  getWhatsappQueueWatcherStatus,
  processarFilaUmaRodada
};
