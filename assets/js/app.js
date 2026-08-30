/* Janela única do Gerenciador MyZap (v3).
 * Filosofia (herdada do estudo/wuzapi): a tela Início traduz o estado do
 * sistema em UMA frase sem jargão + UM botão de ação. O resto é detalhe
 * organizado por aba. Nada de botão de contorno de bug. */

const $ = (id) => document.getElementById(id);

/* ── estado compartilhado dos polls ── */
let overview = null;
let sessao = { status: 'desconhecida', qr: null, raw: null };
let abaAtiva = 'inicio';

/* ── navegação por abas ── */
function irParaAba(tab) {
  if (!document.querySelector(`.tab[data-tab="${tab}"]`)) return;
  abaAtiva = tab;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.id === `pane-${tab}`));
  if (tab === 'whatsapp') pollSessao(true);
  if (tab === 'mensagens') pollPendentes();
  if (tab === 'config') carregarConfig();
}

document.querySelectorAll('.tab').forEach((b) => {
  b.addEventListener('click', () => irParaAba(b.dataset.tab));
});
window.api.onGotoTab((tab) => irParaAba(tab));

const tabInicial = new URLSearchParams(location.search).get('tab');
if (tabInicial) irParaAba(tabInicial);

/* ── helpers de sessão ── */
function classificarSessao(snap) {
  const st = String(snap?.session_status || '').toLowerCase();
  if (['connected', 'islogged', 'inchat', 'chat', 'qrreadsuccess'].some((k) => st.includes(k))) return 'conectada';
  if (snap?.qr_base64) return 'aguardando_qr';
  if (['initializing', 'starting', 'opening', 'loading'].some((k) => st.includes(k))) return 'iniciando';
  if (['notfound', 'not_found', 'closed', 'disconnected', 'notlogged', 'desconnected'].some((k) => st.includes(k))) return 'desconectada';
  if (!st || st === 'unknown') return 'desconhecida';
  return 'desconectada';
}

const LABEL_SESSAO = {
  conectada: 'Conectado',
  aguardando_qr: 'Aguardando QR Code',
  iniciando: 'Iniciando…',
  desconectada: 'Desconectado',
  desconhecida: 'Verificando…'
};

/* ── polls ── */
async function pollOverview() {
  try {
    overview = await window.api.getOverview();
  } catch (_e) { /* mantém o último */ }
  renderTudo();
}

let pollSessaoBusy = false;
async function pollSessao(force = false) {
  if (pollSessaoBusy) return;
  if (!force && abaAtiva !== 'whatsapp' && abaAtiva !== 'inicio') return;
  if (overview && (!overview.configured || overview.modoIntegracao !== 'local')) {
    sessao = { status: overview.configured ? 'modo_web' : 'sem_config', qr: null, raw: null };
    renderTudo();
    return;
  }
  pollSessaoBusy = true;
  try {
    const snap = await window.api.getSessionSnapshot();
    sessao = { status: classificarSessao(snap), qr: snap?.qr_base64 || null, raw: snap };
  } catch (_e) {
    sessao = { status: 'desconhecida', qr: null, raw: null };
  } finally {
    pollSessaoBusy = false;
  }
  renderTudo();
}

/* ── SEMÁFORO: estado composto → frase + ação ── */
function avaliar() {
  const o = overview;
  if (!o) return { nivel: 'neutro', titulo: 'Verificando o sistema…', explicacao: 'Aguarde um instante.', acao: null };

  if (!o.configured) {
    return {
      nivel: 'problema',
      titulo: 'Falta configurar o sistema',
      explicacao: 'Informe o código da empresa, o endereço e o token de acesso — leva 1 minuto e o resto é automático.',
      acao: { label: 'Configurar agora', fn: () => irParaAba('config') }
    };
  }

  if (o.modoIntegracao !== 'local') {
    return {
      nivel: 'ok',
      titulo: 'Modo online ativo',
      explicacao: 'Esta empresa está configurada para enviar pelo servidor, então nada roda neste computador. Para usar o envio local, altere o modo no sistema.',
      acao: null
    };
  }

  const sup = o.supervisor;
  const servicoSaudavel = Boolean(sup?.saudavel);
  if (sup?.breaker?.estado === 'open') {
    return {
      nivel: 'problema',
      titulo: 'O serviço local não está conseguindo se manter no ar',
      explicacao: 'As recuperações automáticas falharam várias vezes seguidas (isso costuma ser antivírus ou disco cheio). O reparo manual resolve na maioria dos casos.',
      acao: { label: 'Resolver problemas', fn: repararAgora }
    };
  }
  if (!servicoSaudavel && sup?.ativo) {
    return {
      nivel: 'atencao',
      titulo: 'O serviço local está se recuperando',
      explicacao: 'Detectamos uma falha e a recuperação automática já está agindo. Se continuar assim por mais de 5 minutos, use o reparo.',
      acao: { label: 'Reparar agora', fn: repararAgora }
    };
  }

  if (sessao.status === 'desconectada') {
    return {
      nivel: 'atencao',
      titulo: 'O WhatsApp não está conectado',
      explicacao: 'Sem a conexão, as mensagens ficam aguardando na fila. Conectar leva menos de um minuto com o QR Code.',
      acao: { label: 'Conectar WhatsApp', fn: () => irParaAba('whatsapp') }
    };
  }
  if (sessao.status === 'aguardando_qr') {
    return {
      nivel: 'atencao',
      titulo: 'QR Code pronto — falta escanear',
      explicacao: 'Abra o WhatsApp no celular, vá em Aparelhos conectados e aponte a câmera para o código.',
      acao: { label: 'Ver QR Code', fn: () => irParaAba('whatsapp') }
    };
  }
  if (sessao.status === 'iniciando') {
    return {
      nivel: 'neutro',
      titulo: 'Conectando o WhatsApp…',
      explicacao: 'A sessão está subindo (o navegador interno pode levar alguns segundos). O QR aparece sozinho se for preciso.',
      acao: null
    };
  }

  if (o.envioPausadoPeloUsuario) {
    return {
      nivel: 'atencao',
      titulo: 'Envio pausado por você',
      explicacao: 'As mensagens estão acumulando na fila e nada será enviado até você retomar.',
      acao: { label: 'Retomar envio', fn: alternarEnvio }
    };
  }
  const q = o.queue;
  if (q?.motivoPausa === 'aguardando_myzap') {
    return {
      nivel: 'atencao',
      titulo: 'O envio foi pausado por segurança',
      explicacao: 'O serviço local parou de responder no meio do trabalho. A fila retoma sozinha assim que ele voltar — nenhuma mensagem se perde.',
      acao: { label: 'Ver detalhes', fn: () => irParaAba('mensagens') }
    };
  }
  if (q?.motivoPausa === 'aguardando_credenciais') {
    return {
      nivel: 'atencao',
      titulo: 'Aguardando as credenciais do sistema',
      explicacao: 'A fila está de pé, mas faltam dados da sua conta. Isso normalmente se resolve sozinho em instantes; confira as Configurações se persistir.',
      acao: { label: 'Ver configurações', fn: () => irParaAba('config') }
    };
  }
  if (q && q.dentroDaJanela === false) {
    return {
      nivel: 'ok',
      titulo: 'Fora do horário de envio',
      explicacao: `Suas mensagens serão enviadas dentro da janela configurada (${q.ritmo?.horarioInicio || '—'} às ${q.ritmo?.horarioFim || '—'}). Tudo certo.`,
      acao: null
    };
  }

  const enviados = q?.enviadosHoje ?? 0;
  return {
    nivel: 'ok',
    titulo: 'Tudo funcionando',
    explicacao: `WhatsApp conectado e envio automático ativo. ${enviados > 0 ? `${enviados} mensagem(ns) enviada(s) hoje.` : 'Aguardando novas mensagens na fila.'}`,
    acao: null
  };
}

/* ── render ── */
function renderTudo() {
  const o = overview;

  // topo
  if (o) $('top-versao').textContent = `v${o.appVersion}${o.isPackaged ? '' : ' · dev'}`;
  const chip = $('chip-sessao');
  const mapaChip = {
    conectada: ['chip-ok', 'WhatsApp conectado'],
    aguardando_qr: ['chip-warn', 'Aguardando QR'],
    iniciando: ['chip-neutro', 'Conectando…'],
    desconectada: ['chip-bad', 'WhatsApp desconectado'],
    desconhecida: ['chip-neutro', 'Verificando…'],
    modo_web: ['chip-neutro', 'Modo online'],
    sem_config: ['chip-warn', 'Sem configuração']
  };
  const [cls, txt] = mapaChip[sessao.status] || mapaChip.desconhecida;
  chip.className = `chip ${cls}`;
  chip.textContent = txt;

  // semáforo
  const st = avaliar();
  const sem = $('semaforo');
  sem.className = `semaforo nivel-${st.nivel}`;
  $('sem-titulo').textContent = st.titulo;
  $('sem-explicacao').textContent = st.explicacao;
  const btnAcao = $('sem-acao');
  if (st.acao) {
    btnAcao.textContent = st.acao.label;
    btnAcao.onclick = st.acao.fn;
    btnAcao.classList.remove('d-none');
  } else {
    btnAcao.classList.add('d-none');
  }

  // cards
  if (o) {
    const sup = o.supervisor;
    const servOk = Boolean(sup?.saudavel);
    $('dot-servico').className = `dot ${servOk ? 'dot-ok' : (sup?.ativo ? 'dot-warn' : 'dot-bad')}`;
    $('card-servico').textContent = servOk ? 'No ar' : (sup?.ativo ? 'Recuperando…' : 'Parado');
    $('card-servico-sub').textContent = sup?.ultimaRecuperacao
      ? `última recuperação: degrau ${sup.ultimaRecuperacao.degrau ?? '—'}`
      : 'supervisão a cada 15s';

    const dotWa = { conectada: 'dot-ok', aguardando_qr: 'dot-warn', iniciando: 'dot-warn', desconectada: 'dot-bad' }[sessao.status] || 'dot';
    $('dot-whats').className = `dot ${dotWa}`;
    $('card-whats').textContent = LABEL_SESSAO[sessao.status] || (sessao.status === 'modo_web' ? 'Modo online' : '—');
    $('card-whats-sub').textContent = sessao.status === 'conectada' ? 'reconexão automática ativa' : '';

    const q = o.queue;
    const envioAtivo = Boolean(q?.ativo) && !o.envioPausadoPeloUsuario;
    $('dot-envio').className = `dot ${o.envioPausadoPeloUsuario ? 'dot-warn' : (envioAtivo ? 'dot-ok' : 'dot-warn')}`;
    $('card-envio').textContent = o.envioPausadoPeloUsuario ? 'Pausado por você' : (envioAtivo ? 'Automático' : (q?.motivoPausa ? 'Aguardando' : 'Preparando…'));
    const teto = q?.ritmo?.tetoDiario;
    $('card-envio-sub').textContent = `hoje: ${q?.enviadosHoje ?? 0}${teto ? ` de ${teto}` : ''} enviadas`;

    $('card-versoes').textContent = `app v${o.appVersion} · MyZap ${o.packVersion ? `v${o.packVersion}` : 'v2 (legado)'}`;
    const up = o.updater || {};
    const upTxt = {
      idle: 'atualizações automáticas ativas',
      checking: 'buscando atualização…',
      downloading: `baixando atualização ${up.percent ? `(${up.percent}%)` : ''}`,
      downloaded: 'atualização pronta — aplica ao reiniciar',
      up_to_date: 'tudo atualizado',
      error: 'falha na última busca',
      dev: 'modo desenvolvimento'
    }[up.phase] || '';
    $('card-versoes-sub').textContent = upTxt;
    $('upd-estado').textContent = upTxt || '—';
  }

  // aba WhatsApp
  $('wa-estado').textContent = LABEL_SESSAO[sessao.status] || sessao.status;
  const img = $('qr-img');
  const ph = $('qr-placeholder');
  if (sessao.qr) {
    img.src = sessao.qr.startsWith('data:') ? sessao.qr : `data:image/png;base64,${sessao.qr}`;
    img.classList.remove('d-none');
    ph.classList.add('d-none');
  } else {
    img.classList.add('d-none');
    ph.classList.remove('d-none');
    ph.innerHTML = {
      conectada: '✅ WhatsApp conectado. Não precisa de QR Code.',
      iniciando: 'Preparando a sessão… o QR aparece aqui sozinho.',
      aguardando_qr: 'Gerando o QR Code…'
    }[sessao.status] || 'Clique em <b>Conectar</b> para gerar o QR Code.';
  }

  // aba Mensagens
  if (o?.queue) {
    const q = o.queue;
    $('sw-envio').checked = !o.envioPausadoPeloUsuario;
    const r = q.ritmo || {};
    const janela = (r.horarioInicio && r.horarioFim) ? `${r.horarioInicio}–${r.horarioFim}` : '24h';
    $('fila-resumo').textContent =
      `Ritmo: ${r.intervaloMsgMinSeg ?? '—'}–${r.intervaloMsgMaxSeg ?? '—'}s entre mensagens · janela ${janela} · hoje ${q.enviadosHoje ?? 0}${r.tetoDiario ? `/${r.tetoDiario}` : ''} enviadas · último lote: ${q.ultimoLote ?? 0}`;
    const alerta = $('fila-alerta');
    const msgAlerta = o.envioPausadoPeloUsuario
      ? 'Envio pausado por você — as mensagens ficam aguardando na fila.'
      : (q.motivoPausa === 'aguardando_myzap'
        ? 'Pausa de segurança: o serviço local parou de responder. A fila retoma sozinha quando ele voltar.'
        : (q.motivoPausa === 'aguardando_credenciais'
          ? 'Aguardando credenciais do sistema — retoma sozinho.'
          : (q.motivoOcioso === 'fora_janela' ? 'Fora da janela de horário — os envios retomam no próximo período.'
            : (q.motivoOcioso === 'teto_diario' ? 'Teto diário atingido — os envios retomam amanhã.' : ''))));
    alerta.textContent = msgAlerta;
    alerta.classList.toggle('d-none', !msgAlerta);
  }
}

/* ── ação do semáforo: reparo de 1 clique ── */
async function repararAgora() {
  $('sem-titulo').textContent = 'Reparando o sistema…';
  $('sem-explicacao').textContent = 'Isso pode levar alguns minutos. Pode continuar usando o computador normalmente.';
  $('sem-acao').classList.add('d-none');
  try {
    await window.api.repairService();
  } catch (_e) { /* o resultado chega pelo proximo poll */ }
  pollOverview();
}

/* ── ações: WhatsApp ── */
async function conectar() {
  $('wa-feedback').textContent = 'Iniciando a sessão…';
  try {
    const r = await window.api.connectSession();
    $('wa-feedback').textContent = r?.message || '';
  } catch (e) {
    $('wa-feedback').textContent = `Erro: ${e.message}`;
  }
  pollSessao(true);
}

async function desconectar() {
  const certeza = confirm('Desconectar o WhatsApp deste computador?\n\nO envio para até você conectar de novo (vai precisar escanear o QR Code outra vez).');
  if (!certeza) return;
  $('wa-feedback').textContent = 'Desconectando…';
  try {
    await window.api.deleteSession();
    $('wa-feedback').textContent = 'Sessão encerrada. Clique em Conectar quando quiser voltar.';
  } catch (e) {
    $('wa-feedback').textContent = `Erro: ${e.message}`;
  }
  pollSessao(true);
}

async function reconectar() {
  const certeza = confirm('Forçar reconexão encerra a sessão atual e cria uma nova (pode pedir QR Code). Continuar?');
  if (!certeza) return;
  $('wa-feedback').textContent = 'Forçando reconexão…';
  try {
    const r = await window.api.forceReconnect();
    $('wa-feedback').textContent = r?.message || '';
  } catch (e) {
    $('wa-feedback').textContent = `Erro: ${e.message}`;
  }
  pollSessao(true);
}

async function testeParaMim() {
  $('wa-feedback').textContent = 'Enviando teste para o seu próprio número…';
  try {
    const r = await window.api.sendSelfTest();
    $('wa-feedback').textContent = r?.message || '';
  } catch (e) {
    $('wa-feedback').textContent = `Erro: ${e.message}`;
  }
}

$('btn-conectar').addEventListener('click', conectar);
$('btn-desconectar').addEventListener('click', desconectar);
$('btn-reconectar').addEventListener('click', reconectar);
$('btn-teste-mim').addEventListener('click', testeParaMim);

/* ── ações: Mensagens ── */
async function alternarEnvio() {
  await window.api.toggleEnvio();
  pollOverview();
}
$('sw-envio').addEventListener('change', alternarEnvio);

async function pollPendentes() {
  try {
    const pendentes = await window.api.getQueuePendentes();
    const tbody = document.querySelector('#tab-pendentes tbody');
    if (!Array.isArray(pendentes) || pendentes.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="muted">Sem mensagens na fila agora.</td></tr>';
      return;
    }
    tbody.innerHTML = pendentes.slice(0, 30).map((m) => {
      let resumo = '';
      try {
        const p = JSON.parse(m.json || '{}');
        resumo = `${p.endpoint || ''} → ${p.data?.number || ''}`;
      } catch (_e) { resumo = '(conteúdo inválido)'; }
      return `<tr><td>${m.idfila ?? ''}</td><td>${m.idempresa ?? ''}</td><td>${m.status ?? ''}</td><td>${resumo}</td></tr>`;
    }).join('');
  } catch (_e) { /* mantém tabela */ }
}

$('btn-cancelar-pendentes').addEventListener('click', async () => {
  const certeza = confirm('Cancelar TODAS as mensagens pendentes?\n\nElas não serão enviadas — nem agora, nem depois. Use apenas em emergência (ex.: campanha disparada por engano).');
  if (!certeza) return;
  const r = await window.api.cancelarPendentesBackend();
  alert(r?.message || 'Feito.');
  pollPendentes();
});

/* ── Configurações ── */
async function carregarConfig() {
  $('cfg-idempresa').value = (await window.api.getStore('idempresa')) || '';
  $('cfg-apiurl').value = (await window.api.getStore('apiUrl')) || '';
  $('cfg-apitoken').value = (await window.api.getStore('apiToken')) || '';
  $('cfg-msg-padrao').value = (await window.api.getStore('myzap_mensagemPadrao')) || '';
}

$('form-config').addEventListener('submit', (ev) => {
  ev.preventDefault();
  window.api.send('settings-saved', {
    idempresa: $('cfg-idempresa').value.trim(),
    apiUrl: $('cfg-apiurl').value.trim(),
    apiToken: $('cfg-apitoken').value.trim()
  });
  $('cfg-feedback').textContent = 'Salvo! Conectando ao sistema…';
  setTimeout(() => { $('cfg-feedback').textContent = ''; pollOverview(); }, 4000);
});

$('btn-salvar-msg').addEventListener('click', async () => {
  $('msg-feedback').textContent = 'Salvando…';
  try {
    const r = await window.api.setMensagemPadrao($('cfg-msg-padrao').value);
    $('msg-feedback').textContent = r?.status === 'success' ? 'Salvo no MyZap!' : (r?.message || 'Salvo (aplica quando o serviço subir).');
  } catch (e) {
    $('msg-feedback').textContent = `Erro: ${e.message}`;
  }
});

$('btn-buscar-updates').addEventListener('click', async () => {
  const r = await window.api.checkAllUpdates();
  $('upd-estado').textContent = r?.message || 'Buscando…';
});

/* ── Ajuda ── */
$('btn-diagnostico').addEventListener('click', async () => {
  const texto = await window.api.getDiagnostics();
  try {
    await navigator.clipboard.writeText(texto);
    $('diag-feedback').textContent = 'Copiado! Cole na conversa com o suporte.';
  } catch (_e) {
    $('diag-feedback').textContent = 'Não consegui copiar — veja o console.';
    console.log(texto);
  }
  setTimeout(() => { $('diag-feedback').textContent = ''; }, 6000);
});

$('sw-tecnico').addEventListener('change', (ev) => {
  $('area-tecnica').classList.toggle('d-none', !ev.target.checked);
});

$('btn-reparar').addEventListener('click', async () => {
  $('tec-feedback').textContent = 'Reparando… isso pode levar alguns minutos.';
  const r = await window.api.repairService();
  $('tec-feedback').textContent = r?.message || 'Reparo finalizado.';
  pollOverview();
});

$('btn-ver-logs').addEventListener('click', () => window.api.openLogViewer());
$('btn-pasta-logs').addEventListener('click', () => window.api.openLogsFolder());

$('btn-reset').addEventListener('click', async () => {
  if (!confirm('RESET GERAL: apaga a instalação local do MyZap, a sessão do WhatsApp e as configurações locais dele.\n\nTem certeza?')) return;
  if (!confirm('Última confirmação: depois do reset será preciso reinstalar e escanear o QR Code de novo. Continuar?')) return;
  $('tec-feedback').textContent = 'Resetando…';
  const r = await window.api.resetEnvironment({ removeTools: false });
  $('tec-feedback').textContent = r?.message || 'Reset concluído.';
  pollOverview();
});

/* ── loops ── */
pollOverview();
pollSessao(true);
setInterval(pollOverview, 4000);
setInterval(() => pollSessao(false), 5000);
setInterval(() => { if (abaAtiva === 'mensagens') pollPendentes(); }, 6000);
