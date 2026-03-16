const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const extractZip = require('extract-zip');
const { error: logError, info } = require('./myzapLogger');

const MYZAP_ARCHIVE_URL = 'https://codeload.github.com/JZ-TECH-SYS/myzap/zip/refs/heads/main';
const MAX_REDIRECTS = 5;

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

    request.on('error', (err) => {
      try {
        fs.rmSync(destinationPath, { force: true });
      } catch (_cleanupError) { /* melhor esforco */ }
      reject(err);
    });
  });
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myzap-archive-'));
  const archivePath = path.join(tempDir, 'myzap-main.zip');

  try {
    validarDestinoInstalacao(dirPath);
    fs.mkdirSync(path.dirname(dirPath), { recursive: true });

    reportProgress('Baixando pacote compactado do MyZap...', 'download_archive', {
      percent: 35,
      dirPath,
      archiveUrl: MYZAP_ARCHIVE_URL,
    });

    await baixarArquivo(MYZAP_ARCHIVE_URL, archivePath);

    reportProgress('Extraindo arquivos do MyZap...', 'extract_archive', {
      percent: 45,
      dirPath,
      archiveUrl: MYZAP_ARCHIVE_URL,
    });

    await extractZip(archivePath, { dir: tempDir });

    const extractedRoot = localizarRaizExtraida(tempDir);
    copiarConteudoDiretorio(extractedRoot, dirPath);

    info('Pacote do MyZap baixado e extraido com sucesso', {
      metadata: {
        area: 'repositoryArchive',
        dirPath,
        archiveUrl: MYZAP_ARCHIVE_URL,
      },
    });

    return {
      archiveUrl: MYZAP_ARCHIVE_URL,
      extractedRoot,
    };
  } catch (err) {
    logError('Falha ao baixar ou extrair o pacote do MyZap', {
      metadata: {
        area: 'repositoryArchive',
        dirPath,
        archiveUrl: MYZAP_ARCHIVE_URL,
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
  downloadRepositoryArchive,
};
