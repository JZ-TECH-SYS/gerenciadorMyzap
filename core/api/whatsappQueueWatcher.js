const Store = require('electron-store');
const { info, warn, error, debug } = require('../myzap/myzapLogger');
// Canal 'backend' dedicado para as chamadas ao DisparaZap (pendentes / fila/status).
const backendLog = require('./backendLogger');
const {
  isCapabilityEnabled,
  getCapabilityEntry,
  getBackendApiConfig
} = require('../myzap/capabilities');
// Ritmo humano (intervalo entre msgs, janela de horario, teto diario) vindo do backend.
const { getRitmo, refreshRitmoIfStale } = require('./ritmoConfig');
const { getMyZapApiBaseUrls } = require('../myzap/api/requestMyZapApi');

const store = new Store();
// 127.0.0.1 (e nao "localhost", que pode resolver para ::1 no Windows e dar
// timeout num MyZap que escuta so IPv4). Lista vem do helper central.
const MYZAP_API_URL = getMyZapApiBaseUrls()[0] || 'http://127.0.0.1:5555/';
const LOOP_INTERVAL_MS = 3000;
const FETCH_TIMEOUT_MS = 15000;
// O ciclo pode durar mais agora que o ritmo HUMANO (segundos entre msgs) e aplicado
// aqui no worker. A trava de re-entrada acompanha esse teto; quando o ciclo se aproxima
// dele o lote e pausado e retomado no proximo tick (ver guarda no loop de envio).
const PROCESSANDO_TIMEOUT_MS = 180000;

// Limite de caracteres da resposta crua do MyZap enviada ao backend / logada.
const MAX_RESPOSTA_MYZAP_CHARS = 2000;

// Humanizacao "digitando": antes de cada sendText o MyZap (WPPConnect) simula
// digitacao por `time_typing` ms (proporcional ao tamanho do texto, com piso/teto).
// Engines que nao suportam ignoram o campo (no-op).
const TYPING_MIN_MS = 1500;
const TYPING_MAX_MS = 6000;
const TYPING_CHARS_POR_SEG = 12;

// Teto absoluto do atraso entre mensagens (defesa contra config patologica): evita
// que um unico sleep gigante estoure a trava de re-entrada do ciclo.
const DELAY_ENTRE_MSG_TETO_MS = 120000;
// Piso do atraso entre mensagens: mesmo com intervalo_msg=0 (config errada/corrompida)
// nunca enviamos em rajada sub-segundo (o que bloqueia o numero).
const DELAY_ENTRE_MSG_PISO_MS = 1000;
// Teto de mensagens reivindicadas por ciclo. Dimensionado dinamicamente pelo delay
// (ver calcularLimiteCiclo) para o lote SEMPRE drenar dentro de um ciclo — assim
// nenhuma mensagem reivindicada fica presa em 'processando' esperando o timeout.
const LIMITE_CICLO_MAX = 10;

// Reconexao: backoff simples enquanto o MyZap estiver indisponivel.
const BACKOFF_BASE_MS = LOOP_INTERVAL_MS;
const BACKOFF_MAX_MS = 30000;

// Chave no electron-store para persistir o ultimo erro de envio/ciclo.
const STORE_ULTIMO_ERRO_KEY = 'myzap_queueWatcherUltimoErro';
// Contador de envios do dia (teto diario): { dia: 'YYYY-MM-DD', total: N }.
const STORE_ENVIOS_DIA_KEY = 'myzap_enviosDoDia';

// Proxima rodada de processamento so volta a acontecer apos esse timestamp (backoff).
let backoffAteEm = 0;
// Ultimo motivo de ociosidade ja logado (evita repetir o mesmo log a cada 3s).
let ultimoMotivoOcioso = '';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Atraso aleatorio (ms) ENTRE mensagens, vindo do ritmo configurado no backend
// (ritmo.intervalo_msg_min/max_seg). Substitui o antigo fixo de 300-1500ms, que
// gerava rajadas sub-segundo e bloqueio do numero.
function randomDelayMs() {
  const r = getRitmo();
  let min = Math.max(DELAY_ENTRE_MSG_PISO_MS, r.intervaloMsgMinSeg * 1000);
  let max = Math.max(min, r.intervaloMsgMaxSeg * 1000);
  min = Math.min(min, DELAY_ENTRE_MSG_TETO_MS);
  max = Math.min(max, DELAY_ENTRE_MSG_TETO_MS);
  return Math.floor(min + Math.random() * (max - min));
}

// Quantas mensagens reivindicar por ciclo: no PIOR caso (delay maximo + digitando +
// timeout de fetch por msg) o lote ainda precisa drenar dentro do orcamento do ciclo
// (PROCESSANDO_TIMEOUT_MS - FETCH_TIMEOUT_MS), com margem. Evita reivindicar 15 e so
// conseguir enviar 3, deixando 12 presas em 'processando'.
function calcularLimiteCiclo() {
  const r = getRitmo();
  const maxDelayMs = Math.min(DELAY_ENTRE_MSG_TETO_MS, Math.max(0, r.intervaloMsgMaxSeg * 1000));
  const custoPorMsg = maxDelayMs + TYPING_MAX_MS + FETCH_TIMEOUT_MS;
  const orcamento = (PROCESSANDO_TIMEOUT_MS - FETCH_TIMEOUT_MS) * 0.8;
  const n = Math.floor(orcamento / Math.max(1, custoPorMsg));
  return Math.min(LIMITE_CICLO_MAX, Math.max(1, n));
}

// Janela de horario permitido (hora LOCAL do PC do operador). Sem janela => 24h.
// Suporta janela cruzando a meia-noite (ex.: 20:00 -> 06:00).
function dentroDaJanela(r) {
  const inicio = r.horarioInicio;
  const fim = r.horarioFim;
  if (!inicio || !fim || inicio === fim) return true;
  const agora = new Date();
  const hhmm = `${String(agora.getHours()).padStart(2, '0')}:${String(agora.getMinutes()).padStart(2, '0')}`;
  if (inicio < fim) return hhmm >= inicio && hhmm <= fim;
  return hhmm >= inicio || hhmm <= fim; // janela cruza a meia-noite
}

function hojeISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getEnviosHoje() {
  const raw = store.get(STORE_ENVIOS_DIA_KEY);
  if (!raw || typeof raw !== 'object' || !raw.dia) return 0;
  const total = Math.max(0, Number(raw.total) || 0);
  const hoje = hojeISO();
  // Mesmo dia OU relogio do PC andou para TRAS (dia armazenado no "futuro"): mantem a
  // contagem — assim um ajuste de relogio nao zera o teto e libera uma rajada. So zera
  // de fato quando o dia avanca (hoje > dia armazenado).
  if (raw.dia >= hoje) return total;
  return 0;
}

function registrarEnvioHoje() {
  const total = getEnviosHoje() + 1;
  const raw = store.get(STORE_ENVIOS_DIA_KEY);
  const diaArmazenado = raw && typeof raw === 'object' && raw.dia ? String(raw.dia) : '';
  const hoje = hojeISO();
  // Rotulo do dia nunca anda para tras (protege contra relogio retrocedido).
  const dia = diaArmazenado > hoje ? diaArmazenado : hoje;
  store.set(STORE_ENVIOS_DIA_KEY, { dia, total });
  return total;
}

// true se ainda ha cota no teto diario (0 = ilimitado).
function dentroDoTetoDiario(r) {
  return !r.tetoDiario || getEnviosHoje() < r.tetoDiario;
}

// Atraso de "digitando" (ms) para um texto: proporcional ao tamanho, com piso/teto.
function typingMsParaTexto(texto) {
  const len = String(texto || '').length;
  if (len === 0) return 0;
  const estimado = Math.round((len / TYPING_CHARS_POR_SEG) * 1000);
  return Math.min(TYPING_MAX_MS, Math.max(TYPING_MIN_MS, estimado));
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
// A partir deste numero de skips a fila entra em estado PAUSADO-AGUARDANDO
// (motivoPausa) — ela NUNCA mais se auto-desliga: o loop continua barato
// (backoff com teto) e retoma sozinho quando o MyZap/credenciais voltarem.
const MAX_CONSECUTIVE_SKIPS = 10;
const SKIP_LOG_EVERY = 5;

// 'aguardando_myzap' | 'aguardando_credenciais' | null
let motivoPausa = null;
let notifyCallback = null;
let ultimoToastPausaAt = 0;
const PAUSA_TOAST_COOLDOWN_MS = 10 * 60 * 1000;

/** Injetado pelo main.js (tray.notify) para avisar pausa/retomada da fila. */
function setQueueNotifier(fn) {
  notifyCallback = (typeof fn === 'function') ? fn : null;
}

function notificarFila(mensagem, { comCooldown = false } = {}) {
  if (!notifyCallback) return;
  if (comCooldown) {
    const agora = Date.now();
    if (agora - ultimoToastPausaAt < PAUSA_TOAST_COOLDOWN_MS) return;
    ultimoToastPausaAt = agora;
  }
  try {
    notifyCallback(mensagem);
  } catch (_e) { /* melhor esforco */ }
}

function entrarEmPausa(motivo, mensagem) {
  if (motivoPausa === motivo) return;
  motivoPausa = motivo;
  warn(`[FilaMyZap] Fila pausada (${motivo}) — retoma sozinha quando resolver`, {
    metadata: { categoria: 'conexao', area: 'whatsappQueueWatcher', motivo, consecutiveSkips }
  });
  notificarFila(mensagem, { comCooldown: true });
}

function sairDaPausa() {
  if (!motivoPausa) return;
  const motivoAnterior = motivoPausa;
  motivoPausa = null;
  info('[FilaMyZap] Fila retomada automaticamente', {
    metadata: { categoria: 'conexao', area: 'whatsappQueueWatcher', motivoAnterior }
  });
  notificarFila('Fila de mensagens retomada: MyZap respondendo novamente.');
}

function normalizeBaseUrl(url) {
  if (!url || typeof url !== 'string') return '';
  return url.endsWith('/') ? url : `${url}/`;
}

function supportsQueuePolling() {
  return isCapabilityEnabled('supportsQueuePolling', store);
}

/**
 * Valida o MyZap via /verifyRealStatus. Retorna SEMPRE:
 * { disponivel, funcional, canAutoRepair, mensagem }
 * - disponivel: o MyZap respondeu HTTP 2xx (comportamento antigo).
 * - funcional: o campo `functional` da resposta. CONNECTED com Store nao carregado
 *   (sessao "zumbi") vem functional=false — nesse estado o envio falha com 404
 *   FALSO de "telefone nao registrado". MyZap antigo (sem o campo) => funcional.
 */
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
    return {
      disponivel: res.ok,
      funcional: res.ok && data?.functional !== false,
      canAutoRepair: data?.canAutoRepair === true,
      mensagem: String(data?.message || '')
    };
  } catch (err) {
    warn('[FilaMyZap] Erro ao validar disponibilidade do MyZap', {
      metadata: { error: err?.message || err }
    });
    return { disponivel: false, funcional: false, canAutoRepair: false, mensagem: '' };
  }
}

// Auto-reparo da sessao zumbi (CONNECTED sem Store): o /verifyRealStatus indica
// canAutoRepair=true e o MyZap expoe POST /repairSession. Cooldown evita martelar.
const REPARO_COOLDOWN_MS = 2 * 60 * 1000;
let ultimoReparoEm = 0;

async function tentarAutoReparoSessao(sessionKey, sessionToken) {
  const agora = Date.now();
  if (agora - ultimoReparoEm < REPARO_COOLDOWN_MS) return false;
  ultimoReparoEm = agora;
  try {
    info('[FilaMyZap] Sessao nao funcional: tentando auto-reparo (/repairSession)', {
      metadata: { categoria: 'conexao', sessionKey }
    });
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(`${MYZAP_API_URL}repairSession`, {
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
    info('[FilaMyZap] Retorno do auto-reparo', {
      metadata: { categoria: 'conexao', status: res.status, data: truncarResposta(data) }
    });
    return res.ok;
  } catch (err) {
    warn('[FilaMyZap] Falha ao acionar auto-reparo da sessao', {
      metadata: { categoria: 'conexao', error: err?.message || err }
    });
    return false;
  }
}

async function buscarPendentes(apiBaseUrl, token, sessionKey, sessionName, idempresa = '', limite = 0) {
  const params = new URLSearchParams({
    sessionKey: sessionKey || '',
    sessionToken: sessionName || ''
  });

  if (idempresa) {
    params.set('idempresa', idempresa);
  }

  // Reivindica no maximo `limite` mensagens (dimensionado pelo ritmo) para o lote
  // sempre caber em um ciclo. Sem limite (0) o backend usa o default.
  if (limite > 0) {
    params.set('limite', String(limite));
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
      // permanente=true (numero sem WhatsApp confirmado): backend nao faz retry
      // e marca o contato. Backends antigos ignoram o campo (retrocompativel).
      permanente: detalheErro.permanente === true,
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
  // "n[aã]o (esta )?registrad" cobre o texto real do MyZap: "O telefone informado
  // nao ESTA registrado no WhatsApp." (a versao sem o "esta" nao casava e o erro
  // caia como myzap_http generico, ganhando 3 retries inuteis).
  const temInexistencia = /(does not exist|not exist|n[aã]o existe|nao existe|not on whatsapp|sem whatsapp|invalid number|n[uú]mero inv[aá]lid|invalid wa|not a valid|nao e um numero|n[aã]o (est[aá] )?registrad|not registered)/.test(txt);
  return temContextoNumero && temInexistencia;
}

/**
 * Detecta na resposta do MyZap que a falha e da SESSAO (caida/desconectada), nao
 * do destinatario. Ex.: {"status":"disconnected","message":"O dispositivo X nao
 * esta conectado."}. Esses erros NAO devem queimar tentativa do contato.
 */
function pareceSessaoCaida(body) {
  if (!body || typeof body !== 'object') return false;
  const status = String(body.status || body.state || '').toLowerCase();
  if (status === 'disconnected' || status === 'notlogged' || status === 'desconnected') return true;
  const txt = String(body.message || body.error || '').toLowerCase();
  return /(n[aã]o est[aá] conectad|not connected|disconnected|sess[aã]o (caiu|perdida|encerrada))/.test(txt);
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

/** Numero de destino (data.number) do payload da fila; '' se nao der pra extrair. */
function extrairNumeroDestino(mensagem) {
  try {
    const payload = mensagem?.json ? JSON.parse(mensagem.json) : {};
    return String(payload?.data?.number || '').trim();
  } catch {
    return '';
  }
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

  // "Digitando" humano: para envios de texto, pede ao MyZap (WPPConnect) que simule
  // digitacao por `time_typing` ms ANTES de enviar. O timeout do abort ganha essa folga.
  let typingMs = 0;
  if (/^send(text|message)$/i.test(endpointNormalizado) && data && typeof data === 'object') {
    typingMs = typingMsParaTexto(data.text ?? data.message ?? data.msg ?? data.content);
    if (typingMs > 0 && data.time_typing === undefined) {
      data.time_typing = typingMs;
    }
  }

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS + typingMs);

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
    // Sessao caida tem prioridade: nesse estado QUALQUER resposta do MyZap e
    // suspeita (inclusive 404 falso de "telefone nao registrado").
    let motivo;
    if (pareceSessaoCaida(body)) {
      motivo = 'sessao_caida';
    } else if (pareceNumeroInvalido(body)) {
      motivo = 'numero_invalido';
    } else {
      motivo = res.status >= 400 ? 'myzap_http' : 'desconhecido';
    }
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

async function listarPendentesMyZap(limite = 0) {
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

  return buscarPendentes(backendApiUrl, backendApiToken, sessionKey, sessionName, idempresa, limite);
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
      // A fila NUNCA se auto-desliga: entra em pausa visivel e retoma sozinha
      // quando as credenciais voltarem (antes, 10 skips matavam a fila em silencio).
      if (consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) {
        entrarEmPausa('aguardando_credenciais',
          'Fila de mensagens pausada: aguardando credenciais do MyZap. Ela retoma sozinha.');
      }
      return;
    }

    const disponibilidade = await validarDisponibilidadeMyZap(configAtual.sessionKey, configAtual.myzapApiToken);
    if (!disponibilidade.disponivel) {
      consecutiveSkips++;
      const atraso = aplicarBackoff();
      if (consecutiveSkips % SKIP_LOG_EVERY === 1) {
        warn(`[FilaMyZap] MyZap indisponivel (skip #${consecutiveSkips}, backoff ${atraso}ms)`, {
          metadata: { categoria: 'conexao', consecutiveSkips, backoffMs: atraso }
        });
      }
      if (consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) {
        entrarEmPausa('aguardando_myzap',
          'Fila de mensagens pausada: aguardando o MyZap voltar a responder. Ela retoma sozinha.');
      }
      return;
    }

    // MyZap responde mas a sessao NAO esta funcional (ex.: CONNECTED com Store nao
    // carregado). Enviar nesse estado gera 404 FALSO de "telefone nao registrado"
    // e queima tentativas dos contatos — entao NAO reivindicamos nada, tentamos o
    // auto-reparo (com cooldown) e deixamos o backoff espacar as checagens.
    if (!disponibilidade.funcional) {
      consecutiveSkips++;
      const atraso = aplicarBackoff();
      warn(`[FilaMyZap] Sessao nao funcional — envio bloqueado (skip #${consecutiveSkips}, backoff ${atraso}ms)`, {
        metadata: { categoria: 'conexao', consecutiveSkips, backoffMs: atraso, detalhe: disponibilidade.mensagem }
      });
      if (disponibilidade.canAutoRepair) {
        await tentarAutoReparoSessao(configAtual.sessionKey, configAtual.myzapApiToken);
      }
      if (consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) {
        entrarEmPausa('aguardando_myzap',
          'Fila pausada: sessao do WhatsApp conectada porem nao funcional. Tente "Reparar" ou reconecte; ela retoma sozinha.');
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
    sairDaPausa();

    // Ritmo humano (intervalo entre msgs, janela de horario, teto diario) vem do
    // backend. Revalida no maximo 1x/min (no-op nas demais chamadas deste loop de 3s).
    await refreshRitmoIfStale();
    const ritmo = getRitmo();

    // Janela de horario: fora do horario permitido nao enviamos. Esta checagem ocorre
    // ANTES de reivindicar (claim) qualquer mensagem, entao nada fica preso em
    // 'processando'. Ocioso (nao conta como skip/backoff de conexao).
    if (!dentroDaJanela(ritmo)) {
      if (ultimoMotivoOcioso !== 'fora_janela') {
        info('[FilaMyZap] Fora da janela de horario permitido — envio pausado', {
          metadata: { categoria: 'fila', horarioInicio: ritmo.horarioInicio, horarioFim: ritmo.horarioFim }
        });
        ultimoMotivoOcioso = 'fora_janela';
      }
      return;
    }

    // Teto diario atingido: pausa ate a virada do dia. Tambem antes do claim.
    if (!dentroDoTetoDiario(ritmo)) {
      if (ultimoMotivoOcioso !== 'teto_diario') {
        info('[FilaMyZap] Teto diario de envios atingido — pausado ate amanha', {
          metadata: { categoria: 'fila', tetoDiario: ritmo.tetoDiario, enviadosHoje: getEnviosHoje() }
        });
        ultimoMotivoOcioso = 'teto_diario';
      }
      return;
    }
    ultimoMotivoOcioso = '';

    // Reivindica apenas o que da pra enviar neste ciclo (evita itens presos em
    // 'processando' quando o ritmo e lento e o lote nao cabe no orcamento do ciclo).
    const pendentes = await listarPendentesMyZap(calcularLimiteCiclo());
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

    // Numeros confirmados sem WhatsApp NESTE ciclo: o 2o componente do mesmo
    // contato (ex.: sendText apos o sendImage falhar) nem chega ao MyZap.
    const numerosInvalidosCiclo = new Set();

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

      // Janela/teto tambem DENTRO do lote: um ciclo pode cruzar o fim do horario ou
      // estourar o teto no meio. O restante ja reivindicado volta a 'pendente' pelo
      // timeout de 'processando' e e reenviado no proximo periodo valido.
      const ritmoLote = getRitmo();
      if (!dentroDaJanela(ritmoLote) || !dentroDoTetoDiario(ritmoLote)) {
        warn('[FilaMyZap] Janela/teto atingido durante o lote: pausando (restante volta a fila)', {
          metadata: { categoria: 'fila', processados: i, restante: lote.length - i }
        });
        break;
      }

      let novoStatus = 'erro';
      // Detalhe rico enviado ao backend apenas em caso de erro (retrocompativel).
      let detalheErro = null;
      // id real da msg no WhatsApp (so no sucesso) -> reportado p/ casar com o ACK.
      let messageId = '';
      // Sessao caiu neste item: devolve o restante do lote e encerra o ciclo.
      let sessaoCaiuNoLote = false;
      try {
        const numeroDestino = extrairNumeroDestino(mensagem);

        if (numeroDestino && numerosInvalidosCiclo.has(numeroDestino)) {
          // Numero ja confirmado sem WhatsApp neste ciclo: erro permanente direto,
          // sem martelar o MyZap de novo (era isso que derrubava a sessao).
          detalheErro = {
            erro: 'Numero sem WhatsApp (confirmado neste ciclo)',
            motivo: 'numero_invalido',
            permanente: true,
            codigo_http: 404,
            resposta_myzap: '',
            etapa: 'validacao'
          };
          info('[FilaMyZap] Pulando componente de numero ja confirmado sem WhatsApp', {
            metadata: { categoria: 'envio', idfila: mensagem?.idfila, numero: numeroDestino }
          });
        } else {
          info('[FilaMyZap] Enviando mensagem', {
            metadata: { categoria: 'envio', idfila: mensagem?.idfila, idempresa: mensagem?.idempresa }
          });

          const envio = await enviarParaMyZap(mensagem, sessionKey, myzapApiToken);
          novoStatus = envio.ok ? 'enviado' : 'erro';

          if (envio.ok) {
            messageId = extrairMessageId(envio.body);
            // Conta no teto diario apenas envios REAIS (skip = ja estava enviado).
            const enviadosHoje = envio.skipped ? getEnviosHoje() : registrarEnvioHoje();
            info('[FilaMyZap] Mensagem enviada com sucesso', {
              metadata: { categoria: 'envio', idfila: mensagem?.idfila, idempresa: mensagem?.idempresa, messageId, enviadosHoje }
            });
          } else {
            let motivo = envio?.motivo || 'desconhecido';
            let permanente = false;

            // 404 "telefone nao registrado" pode ser FALSO quando a sessao esta
            // zumbi (Store nao carregado). Revalida antes de condenar o numero.
            if (motivo === 'numero_invalido') {
              const recheck = await validarDisponibilidadeMyZap(sessionKey, myzapApiToken);
              if (recheck.funcional) {
                permanente = true;
                if (numeroDestino) numerosInvalidosCiclo.add(numeroDestino);
              } else {
                motivo = 'sessao_caida';
              }
            }

            if (motivo === 'sessao_caida' || motivo === 'timeout') {
              // Falha da SESSAO, nao do contato: devolve a 'pendente' sem queimar
              // tentativa e encerra o lote (a sessao precisa se recuperar antes).
              sessaoCaiuNoLote = true;
              novoStatus = 'pendente';
              warn('[FilaMyZap] Sessao caida/instavel durante o envio: item devolvido a fila', {
                metadata: {
                  categoria: 'conexao',
                  idfila: mensagem?.idfila,
                  idempresa: mensagem?.idempresa,
                  motivo,
                  conteudo: truncarResposta(envio?.resposta_myzap)
                }
              });
              setUltimoErroStore({ message: envio?.erro || 'Sessao caida durante o envio', etapa: 'envio' });
            } else {
              // Monta o detalhe do erro para o backend e para o log estruturado.
              detalheErro = {
                erro: envio?.erro || 'Falha no envio',
                motivo,
                permanente,
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
                  permanente: detalheErro.permanente,
                  codigo_http: detalheErro.codigo_http,
                  etapa: detalheErro.etapa,
                  erro: detalheErro.erro,
                  conteudo: truncarResposta(detalheErro.resposta_myzap)
                }
              });
              setUltimoErroStore({ message: detalheErro.erro, etapa: detalheErro.etapa });
            }
          }
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

      if (sessaoCaiuNoLote) {
        // Devolve o RESTANTE reivindicado a 'pendente' (latencia zero; se o backend
        // antigo rejeitar o status, o reaper de 'processando' cobre em ~10min) e
        // entra em backoff: o proximo ciclo so envia com a sessao funcional de novo.
        const restante = lote.slice(i + 1);
        for (const item of restante) {
          await atualizarStatusFila(backendApiUrl, backendApiToken, {
            idfila: item?.idfila,
            idempresa: item?.idempresa || idempresa,
            status: 'pendente'
          });
        }
        warn('[FilaMyZap] Lote interrompido por sessao caida: restante devolvido a fila', {
          metadata: { categoria: 'conexao', processados: i + 1, devolvidos: restante.length }
        });
        consecutiveSkips++;
        aplicarBackoff();
        break;
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
  motivoPausa = null;

  info('Watcher da fila MyZap parado', {
    metadata: { area: 'whatsappQueueWatcher' }
  });

  return { status: 'success', message: 'Watcher da fila MyZap parado com sucesso.' };
}

function getWhatsappQueueWatcherStatus() {
  const proximaExecucaoEm = ultimaExecucaoEm
    ? new Date(new Date(ultimaExecucaoEm).getTime() + LOOP_INTERVAL_MS).toISOString()
    : null;

  const ritmo = getRitmo();

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
    consecutiveSkips,
    // 'aguardando_myzap' | 'aguardando_credenciais' | null — pausa recuperavel
    // (substitui o antigo auto-stop definitivo apos 10 skips).
    motivoPausa,
    // Ritmo humano vigente + progresso do teto diario (para o painel da fila).
    ritmo,
    enviadosHoje: getEnviosHoje(),
    dentroDaJanela: dentroDaJanela(ritmo),
    motivoOcioso: ultimoMotivoOcioso || null
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
  processarFilaUmaRodada,
  setQueueNotifier
};
