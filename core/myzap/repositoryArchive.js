const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const extractZip = require('extract-zip');
const { error: logError, info, warn } = require('./myzapLogger');

const MYZAP_ARCHIVE_BASE = 'https://codeload.github.com/JZ-TECH-SYS/myzap/zip/';
const MYZAP_ARCHIVE_URL = `${MYZAP_ARCHIVE_BASE}refs/heads/main`;
const MAX_REDIRECTS = 5;
// Timeout do download para nao travar pra sempre se a rede estagnar.
const DOWNLOAD_TIMEOUT_MS = 60000;
// Retry do download: rede instavel nao pode ser falha permanente.
const DOWNLOAD_RETRY_DELAYS_MS = [2000, 8000, 30000];

/**
 * Monta a URL do archive. Com um commit SHA, baixa EXATAMENTE aquela versao
 * (elimina corrida com push novo durante o download); sem SHA, baixa a main.
 */
function buildArchiveUrl(sha) {
  const ref = String(sha || '').trim();
  return ref ? `${MYZAP_ARCHIVE_BASE}${ref}` : MYZAP_ARCHIVE_URL;
}

function baixarArquivo(url, destinationPath, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        'User-Agent': 'gerenciador-myzap',
      },
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();

        if (redirectCount >= MAX_REDIRECTS) {
          reject(new Error('Numero maximo de redirecionamentos excedido ao baixar o MyZap.'));
          return;
        }

        const redirectUrl = new URL(response.headers.location, url).toString();
        baixarArquivo(redirectUrl, destinationPath, redirectCount + 1)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Falha ao baixar o pacote do MyZap (HTTP ${response.statusCode}).`));
        return;
      }

      const fileStream = fs.createWriteStream(destinationPath);

      fileStream.on('error', (err) => {
        response.destroy(err);
      });

      response.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close(resolve);
      });

      fileStream.on('error', (err) => {
        try {
          fs.rmSync(destinationPath, { force: true });
        } catch (_cleanupError) { /* melhor esforco */ }
        reject(err);
      });
    });

    // Watchdog de inatividade: se a rede estagnar, destroi o request
    // (dispara o handler 'error' abaixo, que limpa o arquivo e rejeita).
    request.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      request.destroy(new Error('Timeout ao baixar o pacote do MyZap (rede estagnada).'));
    });

    request.on('error', (err) => {
      try {
        fs.rmSync(destinationPath, { force: true });
      } catch (_cleanupError) { /* melhor esforco */ }
      reject(err);
    });
  });
}

async function baixarArquivoComRetry(url, destinationPath) {
  let lastError = null;

  for (let attempt = 0; attempt <= DOWNLOAD_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await baixarArquivo(url, destinationPath);
      return;
    } catch (err) {
      lastError = err;
      const isLastAttempt = attempt === DOWNLOAD_RETRY_DELAYS_MS.length;
      if (isLastAttempt) break;

      const delayMs = DOWNLOAD_RETRY_DELAYS_MS[attempt];
      warn('Download do MyZap falhou, tentando novamente', {
        metadata: {
          area: 'repositoryArchive',
          tentativa: attempt + 1,
          proximaEmMs: delayMs,
          error: err?.message || String(err),
        },
      });
      await new Promise((resolve) => { setTimeout(resolve, delayMs); });
    }
  }

  throw lastError;
}

function validarDestinoInstalacao(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return;
  }

  const entries = fs.readdirSync(dirPath);
  if (entries.length > 0) {
    throw new Error('Erro ao preparar a instalacao do MyZap. Verifique se a pasta de destino ja existe e nao esta vazia.');
  }
}

function localizarRaizExtraida(tempDir) {
  const extractedDirectories = fs.readdirSync(tempDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name.toLowerCase().startsWith('myzap-'));

  if (extractedDirectories.length === 0) {
    throw new Error('Pacote do MyZap baixado, mas a estrutura extraida e invalida.');
  }

  return path.join(tempDir, extractedDirectories[0]);
}

function copiarConteudoDiretorio(sourceDir, destinationDir) {
  fs.mkdirSync(destinationDir, { recursive: true });

  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  entries.forEach((entry) => {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    fs.cpSync(sourcePath, destinationPath, { recursive: true, force: true });
  });
}

async function downloadRepositoryArchive(dirPath, options = {}) {
  const reportProgress = (typeof options.onProgress === 'function')
    ? options.onProgress
    : () => {};
  const archiveUrl = buildArchiveUrl(options.sha);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myzap-archive-'));
  const archivePath = path.join(tempDir, 'myzap-main.zip');

  try {
    validarDestinoInstalacao(dirPath);
    fs.mkdirSync(path.dirname(dirPath), { recursive: true });

    reportProgress('Baixando pacote compactado do MyZap...', 'download_archive', {
      percent: 35,
      dirPath,
      archiveUrl,
    });

    await baixarArquivoComRetry(archiveUrl, archivePath);

    reportProgress('Extraindo arquivos do MyZap...', 'extract_archive', {
      percent: 45,
      dirPath,
      archiveUrl,
    });

    await extractZip(archivePath, { dir: tempDir });

    const extractedRoot = localizarRaizExtraida(tempDir);
    copiarConteudoDiretorio(extractedRoot, dirPath);

    info('Pacote do MyZap baixado e extraido com sucesso', {
      metadata: {
        area: 'repositoryArchive',
        dirPath,
        archiveUrl,
      },
    });

    return {
      archiveUrl,
      extractedRoot,
      sha: String(options.sha || '').trim() || null,
    };
  } catch (err) {
    logError('Falha ao baixar ou extrair o pacote do MyZap', {
      metadata: {
        area: 'repositoryArchive',
        dirPath,
        archiveUrl,
        error: err,
      },
    });
    throw err;
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_cleanupError) { /* melhor esforco */ }
  }
}

module.exports = {
  MYZAP_ARCHIVE_URL,
  buildArchiveUrl,
  baixarArquivoComRetry,
  downloadRepositoryArchive,
};
