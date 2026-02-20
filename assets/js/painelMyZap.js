function setButtonsState({ canStart, canDelete }) {
  const btnStart = document.getElementById('btn-start-session');
  const btnDelete = document.getElementById('btn-delete-session');

  if (btnStart) btnStart.disabled = !canStart;
  if (btnDelete) btnDelete.disabled = !canDelete;
}

function setIaConfigVisibility(isVisible) {
  const box = document.getElementById('ia-config-box');
  if (!box) return;
  box.classList.toggle('d-none', !isVisible);
}


(async () => {
  try {
    await loadConfigs();
  } catch (e) {
    alert('Erro ao carregar configurações: ' + (e?.message || e));
  }
})();


async function loadConfigs() {
  try {
    const myzap_diretorio = (await window.api.getStore('myzap_diretorio')) ?? '';
    const myzap_sessionKey = (await window.api.getStore('myzap_sessionKey')) ?? '';
    const myzap_apiToken = (await window.api.getStore('myzap_apiToken')) ?? '';
    const myzap_envContent = (await window.api.getStore('myzap_envContent')) ?? '';
    const myzap_mensagemPadrao = (await window.api.getStore('myzap_mensagemPadrao')) ?? '';
    const clickexpress_apiUrl = (await window.api.getStore('clickexpress_apiUrl')) ?? '';
    const clickexpress_queueToken = (await window.api.getStore('clickexpress_queueToken')) ?? '';

    const statusConfig = document.getElementById('status-config');
    if (myzap_diretorio && myzap_sessionKey && myzap_apiToken && myzap_envContent) {
      statusConfig.textContent = 'Tudo em ordem!';
      statusConfig.classList.remove('bg-secondary');
      statusConfig.classList.add('bg-success');
    }

    const statusInstallation = document.getElementById('status-installation');

    const hasFiles = await window.api.checkDirectoryHasFiles(
      String(myzap_diretorio)
    );

    statusInstallation.textContent = hasFiles.message || 'Erro na configuração!';
    statusInstallation.classList.remove('bg-secondary');
    statusInstallation.classList.add(hasFiles.status === 'success' ? 'bg-success' : 'bg-danger');
    setInstalled(hasFiles.status === 'success');
    document.getElementById('btn-start').disabled = !(hasFiles.status === 'success');

    if (hasFiles.status === 'success') {
      const statusApi = document.getElementById('status-api');
      statusApi.innerHTML = `
            <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
            Verificando...
        `;

      const start = await window.api.iniciarMyZap(String(myzap_diretorio));
      const btnStart = document.getElementById('btn-start');

      statusApi.textContent = start.message || 'Erro ao iniciar MyZap!';
      statusApi.classList.remove('bg-secondary');
      statusApi.classList.add(start.status === 'success' ? 'bg-success' : 'bg-danger');
      btnStart.disabled = (start.status == 'success');

      if (start.status == 'success') {
        if (myzap_sessionKey) {
          document.getElementById('myzap-sessionkey').value = myzap_sessionKey;
          document.getElementById('myzap-sessionname').value = myzap_sessionKey;
          setInterval(async () => {
            await checkConnection();
          }, 10000);
        }
      }
    }

    document.getElementById('input-path').value = myzap_diretorio;
    document.getElementById('input-sessionkey').value = myzap_sessionKey;
    document.getElementById('input-apitoken').value = myzap_apiToken;
    document.getElementById('input-env').value = myzap_envContent;
    document.getElementById('myzap-mensagem-padrao').value = myzap_mensagemPadrao;
    document.getElementById('input-clickexpress-apiurl').value = clickexpress_apiUrl;
    document.getElementById('input-clickexpress-token').value = clickexpress_queueToken;
  } catch (e) {
    alert('Erro ao carregar configurações: ' + (e?.message || e));
  }
}

async function checkRealConnection() {
  const qrBox = document.getElementById('qrcode-box');
  const statusIndicator = document.querySelector('.status-indicator');

  qrBox.innerHTML = `<span class="text-muted-small">Verificando status real...</span>`;

  try {
    const response = await window.api.verifyRealStatus();

    if (!response.dbStatus && !response.status) {
      throw new Error('Resposta inválida da API');
    }

    const {
      realStatus,
      dbStatus,
      dbState,
      status,
      message
    } = response;

    if (status == 'NOT FOUND') {
      statusIndicator.className = 'status-indicator waiting';
      statusIndicator.textContent = 'Sessão não iniciada!';

      qrBox.innerHTML = `
        <span class="text-muted-small">
          Nenhuma instância de sessão foi criada!
        </span>
      `;

      setButtonsState({ canStart: true, canDelete: false });
      setIaConfigVisibility(false);
      return { isConnected: false, isQrWaiting: false, response };
    }

    const isConnected = realStatus === 'CONNECTED';
    const isQrWaiting = dbState === 'QRCODE' || dbStatus === 'qrCode';

    if (isConnected) {
      statusIndicator.className = 'status-indicator connected';
      statusIndicator.textContent = '✅ Conectado';

      qrBox.innerHTML = `
        <span class="text-muted-small">
          WhatsApp conectado com sucesso
        </span>
      `;

      setButtonsState({ canStart: false, canDelete: true });
      setIaConfigVisibility(true);
      return { isConnected: true, isQrWaiting: false, response };
    }

    if (isQrWaiting) {
      statusIndicator.className = 'status-indicator waiting';
      statusIndicator.textContent = '⏳ Aguardando leitura do QR Code';

      setButtonsState({ canStart: false, canDelete: true });
      setIaConfigVisibility(false);
      return { isConnected: false, isQrWaiting: true, response };
    }

    statusIndicator.className = 'status-indicator disconnected';
    statusIndicator.textContent = '❌ Desconectado';

    qrBox.innerHTML = `
      <span class="text-muted-small">
        ${message || 'QR Code não disponível'}
      </span>
    `;

    setButtonsState({ canStart: true, canDelete: false });
    setIaConfigVisibility(false);
    return { isConnected: false, isQrWaiting: false, response };

  } catch (err) {
    console.error('Erro ao verificar status real:', err);

    statusIndicator.className = 'status-indicator disconnected';
    statusIndicator.textContent = '⚠ Erro de conexão';

    qrBox.innerHTML = `
      <span class="text-danger text-small">
        Erro ao verificar status do MyZap
      </span>
    `;

    setButtonsState({ canStart: false, canDelete: false });
    setIaConfigVisibility(false);
    return { isConnected: false, isQrWaiting: false, response: null };
  }
}

async function checkConnection() {
  const qrBox = document.getElementById('qrcode-box');
  const statusIndicator = document.querySelector('.status-indicator');

  qrBox.innerHTML = `<span class="text-muted-small">Verificando status...</span>`;

  try {
    const realCheck = await checkRealConnection();

    if (!realCheck || realCheck.isConnected) {
      return;
    }

    if (!realCheck.isQrWaiting) {
      return;
    }

    const response = await window.api.getConnectionStatus();

    if (!response || response.result !== 200) {
      throw new Error('Resposta inválida da API');
    }

    const { status, state, qrCode } = response;

    if ((state === 'QRCODE' || status === 'qrCode') && qrCode) {
      statusIndicator.className = 'status-indicator waiting';
      statusIndicator.textContent = '⏳ Aguardando leitura do QR Code';

      qrBox.innerHTML = `
        <img
          src="${qrCode}"
          alt="QR Code WhatsApp"
        />
        <div class="qrcode-hint">
          Escaneie o QR Code com o WhatsApp
        </div>
      `;
    }

  } catch (err) {
    console.error('Erro ao verificar conexão:', err);

    statusIndicator.className = 'status-indicator disconnected';
    statusIndicator.textContent = '⚠ Erro de conexão';

    qrBox.innerHTML = `
      <span class="text-danger text-small">
        Erro ao verificar status do MyZap
      </span>
    `;
  }
}

async function iniciarSessao() {
  const qrBox = document.getElementById('qrcode-box');
  const statusIndicator = document.querySelector('.status-indicator');

  try {
    const realCheck = await checkRealConnection();
    if (realCheck?.isConnected || realCheck?.isQrWaiting) {
      statusIndicator.className = 'status-indicator waiting';
      statusIndicator.textContent = '⚠ Sessão já existe';

      setButtonsState({ canStart: false, canDelete: true });
      return;
    }

    statusIndicator.className = 'status-indicator waiting';
    statusIndicator.textContent = '🚀 Iniciando sessão...';

    qrBox.innerHTML = `
      <span class="text-muted-small">
        Inicializando sessão do WhatsApp...
      </span>
    `;

    const response = await window.api.startSession();

    if (!response || response.result !== 'success') {
      throw new Error('Falha ao iniciar sessão');
    }

    statusIndicator.textContent = '⏳ Sessão iniciada, aguardando QR Code';

    setButtonsState({ canStart: false, canDelete: true });

    setTimeout(checkConnection, 5000);

  } catch (err) {
    console.error('Erro ao iniciar sessão:', err);

    statusIndicator.className = 'status-indicator disconnected';
    statusIndicator.textContent = '❌ Erro ao iniciar sessão';

    qrBox.innerHTML = `
      <span class="text-danger text-small">
        Não foi possível iniciar a sessão
      </span>
    `;
  }
}


async function deletarSessao() {
  const qrBox = document.getElementById('qrcode-box');
  const statusIndicator = document.querySelector('.status-indicator');

  try {
    const realCheck = await checkRealConnection();

    if (!realCheck || (!realCheck.isConnected && !realCheck.isQrWaiting)) {
      statusIndicator.className = 'status-indicator disconnected';
      statusIndicator.textContent = 'ℹ Nenhuma sessão ativa';

      setButtonsState({ canStart: true, canDelete: false });
      return;
    }

    statusIndicator.className = 'status-indicator waiting';
    statusIndicator.textContent = '🧹 Encerrando sessão...';

    qrBox.innerHTML = `
      <span class="text-muted-small">
        Finalizando sessão do WhatsApp...
      </span>
    `;

    const response = await window.api.deleteSession();

    if (!response || response.status !== 'SUCCESS') {
      throw new Error('Falha ao deletar sessão');
    }

    statusIndicator.className = 'status-indicator disconnected';
    statusIndicator.textContent = '❌ Sessão encerrada';

    qrBox.innerHTML = `
      <span class="text-muted-small">
        Sessão removida com sucesso
      </span>
    `;

    setButtonsState({ canStart: true, canDelete: false });

  } catch (err) {
    console.error('Erro ao deletar sessão:', err);

    statusIndicator.className = 'status-indicator disconnected';
    statusIndicator.textContent = '⚠ Erro ao deletar sessão';

    qrBox.innerHTML = `
      <span class="text-danger text-small">
        Não foi possível encerrar a sessão
      </span>
    `;
  }
}

async function salvarMensagemPadrao() {
  const textarea = document.getElementById('myzap-mensagem-padrao');
  const btnSave = document.getElementById('btn-save-ia-config');
  const mensagemPadrao = textarea?.value?.trim() || '';

  if (!mensagemPadrao) {
    alert('Informe uma mensagem padrao antes de salvar.');
    return;
  }

  btnSave.disabled = true;
  const oldText = btnSave.textContent;
  btnSave.textContent = 'Salvando...';

  try {
    const response = await window.api.updateIaConfig(mensagemPadrao);

    if (!response || response.status === 'error') {
      throw new Error(response?.message || 'Falha ao salvar configuracao da IA');
    }

    alert('Mensagem padrao atualizada com sucesso.');
  } catch (err) {
    console.error('Erro ao atualizar mensagem padrao:', err);
    alert(`Erro ao atualizar mensagem padrao: ${err?.message || err}`);
  } finally {
    btnSave.disabled = false;
    btnSave.textContent = oldText;
  }
}

const cfg_myzap = document.getElementById('myzap-config-form');

cfg_myzap.onsubmit = (e) => {
  e.preventDefault();

  const myzap_diretorio = document.getElementById('input-path').value.trim();
  const myzap_sessionKey = document.getElementById('input-sessionkey').value.trim();
  const myzap_apiToken = document.getElementById('input-apitoken').value.trim();
  const myzap_envContent = document.getElementById('input-env').value.trim();
  const clickexpress_apiUrl = document.getElementById('input-clickexpress-apiurl').value.trim();
  const clickexpress_queueToken = document.getElementById('input-clickexpress-token').value.trim();

  if (!myzap_diretorio.toLowerCase().includes('/myzap')) {
    alert('O caminho do diretório deve se remeter ao diretório "myzap". Por exemplo, C:/JzTech/projects/myzap.');
    return;
  }

  window.api.send('myzap-settings-saved', {
    myzap_diretorio,
    myzap_sessionKey,
    myzap_apiToken,
    myzap_envContent,
    clickexpress_apiUrl,
    clickexpress_queueToken
  });

  alert('Configurações salvas!');
  window.close();
};

function atualizaStatus() {
  window.location.reload();
}

function setInstalled(isInstalled) {
  const dropdownBtn = document.getElementById('btn-install-dropdown');
  const mainBtn = document.getElementById('btn-install');

  if (isInstalled) {
    dropdownBtn.classList.remove('d-none');
    mainBtn.innerText = 'Instalado';
    mainBtn.classList.remove('btn-primary');
    mainBtn.classList.add('btn-success');
    mainBtn.disabled = true;
  } else {
    dropdownBtn.classList.add('d-none');
    mainBtn.innerText = 'Instalar';
    mainBtn.classList.remove('btn-success');
    mainBtn.classList.add('btn-primary');
    mainBtn.disabled = false;
  }
}

async function installMyZap() {
  const myzap_diretorio = (await window.api.getStore('myzap_diretorio')) ?? '';
  const myzap_envContent = (await window.api.getStore('myzap_envContent')) ?? '';

  if (!myzap_diretorio) {
    alert('Por favor, salve as configurações antes de instalar o MyZap.');
    return;
  }

  const btnInstall = document.getElementById('btn-install');
  const btnStart = document.getElementById('btn-start');
  const btnRefresh = document.getElementById('btn-refresh-status');
  const statusBadge = document.getElementById('status-installation');

  const originalBtnText = btnInstall.innerHTML;
  const originalBadgeText = statusBadge.textContent;
  const originalBadgeClass = statusBadge.className;

  try {
    btnInstall.disabled = true;
    btnStart.disabled = true;
    btnRefresh.disabled = true;

    btnInstall.innerHTML = `
            <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
            Instalando...
        `;

    statusBadge.textContent = 'Baixando arquivos...';
    statusBadge.className = 'badge bg-warning text-dark status-badge';

    const clone = await window.api.cloneRepository(
      String(myzap_diretorio),
      String(myzap_envContent)
    );

    if (clone.status === 'error') {
      throw new Error(clone.message || 'Erro desconhecido');
    }

    statusBadge.textContent = 'MyZap se encontra no diretório configurado!';
    statusBadge.className = 'badge bg-success status-badge';

    setTimeout(() => {
      alert('MyZap instalado com sucesso!');
      atualizaStatus();
    }, 500);

  } catch (error) {
    console.error(error);
    alert('Erro ao instalar MyZap: ' + error.message);

    btnInstall.innerHTML = originalBtnText;
    btnInstall.disabled = false;

    statusBadge.textContent = 'Falha na instalação';
    statusBadge.className = 'badge bg-danger status-badge';
  }
}

async function reinstallMyZap() {
  if (!confirm('Deseja reinstalar o MyZap? Isso substituirá a instalação atual.')) {
    return;
  }

  const myzap_diretorio = (await window.api.getStore('myzap_diretorio')) ?? '';
  const myzap_envContent = (await window.api.getStore('myzap_envContent')) ?? '';

  if (!myzap_diretorio) {
    alert('Por favor, salve as configurações antes de re-instalar o MyZap.');
    return;
  }

  const btnInstall = document.getElementById('btn-install');
  const btnReInstall = document.getElementById('btn-reinstall');
  const btnStart = document.getElementById('btn-start');
  const btnRefresh = document.getElementById('btn-refresh-status');
  const statusBadge = document.getElementById('status-installation');
  const statusRunBadge = document.getElementById('status-api');
  const dropdownBtn = document.getElementById('btn-install-dropdown');

  const originalBtnText = btnInstall.innerHTML;
  const originalBadgeText = statusBadge.textContent;
  const originalBadgeClass = statusBadge.className;

  try {
    btnInstall.disabled = true;
    btnStart.disabled = true;
    btnReInstall.disabled = true;
    dropdownBtn.disabled = true;
    btnRefresh.disabled = true;

    btnInstall.innerHTML = `
            <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
            Re-Instalando...
        `;

    statusBadge.textContent = 'Baixando arquivos...';
    statusBadge.className = 'badge bg-warning text-dark status-badge';

    statusRunBadge.textContent = 'Aguardando reinstalação...';
    statusRunBadge.className = 'badge bg-secondary status-badge';

    const clone = await window.api.cloneRepository(
      String(myzap_diretorio),
      String(myzap_envContent),
      true
    );

    if (clone.status === 'error') {
      throw new Error(clone.message || 'Erro desconhecido');
    }

    statusBadge.textContent = 'MyZap se encontra no diretório configurado!';
    statusBadge.className = 'badge bg-success status-badge';

    setTimeout(() => {
      alert('MyZap re-instalado com sucesso!');
      atualizaStatus();
    }, 500);

  } catch (error) {
    console.error(error);
    alert('Erro ao re-instalar MyZap: ' + error.message);

    btnInstall.innerHTML = originalBtnText;
    btnInstall.disabled = false;

    statusBadge.textContent = 'Falha na instalação';
    statusBadge.className = 'badge bg-danger status-badge';
    setTimeout(() => {
      atualizaStatus();
    }, 1500);
  }
}
