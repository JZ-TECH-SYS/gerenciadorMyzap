(async () => {
  try {
    document.getElementById('idempresa').value = (await window.api.getStore('idempresa')) ?? '';
    document.getElementById('api').value = (await window.api.getStore('apiUrl')) ?? '';
    document.getElementById('token').value = (await window.api.getStore('apiToken')) ?? '';
  } catch (e) {
    alert('Erro ao carregar configuracoes: ' + (e?.message || e));
  }
})();

const cfg = document.getElementById('cfg');

cfg.onsubmit = (e) => {
  e.preventDefault();

  const idempresa = document.getElementById('idempresa').value.trim();
  const apiUrl = document.getElementById('api').value.trim();
  const apiToken = document.getElementById('token').value.trim();

  if (!apiUrl.startsWith('http')) {
    alert('URL da API invalida');
    return;
  }

  if (!/^\d+$/.test(idempresa)) {
    alert('ID da empresa deve conter apenas numeros');
    return;
  }

  window.api.send('settings-saved', {
    idempresa,
    apiUrl,
    apiToken
  });

  alert('Configuracoes salvas!');
  window.close();
};
