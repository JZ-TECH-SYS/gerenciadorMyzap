const fs = require('fs');
const path = require('path');
const { error, debug } = require('./myzapLogger');

async function verificarDiretorio(dirPath) {
  try {
    debug('Verificando diretorio do MyZap', {
      metadata: { area: 'verificarDiretorio', dirPath }
    });

    if (!dirPath || !fs.existsSync(dirPath)) {
      return {
        status: 'error',
        message: 'MyZap nao se encontra no diretorio configurado!'
      };
    }

    const packageJsonPath = path.join(dirPath, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      return {
        status: 'error',
        message: 'Diretorio existe mas nao contem uma instalacao valida do MyZap!'
      };
    }

    return {
      status: 'success',
      message: 'MyZap se encontra no diretorio configurado!'
    };
  } catch (err) {
    error('Erro ao verificar diretorio do MyZap', {
      metadata: { error: err, area: 'verificarDiretorio', dirPath }
    });
    return {
      status: 'error',
      message: err.message || err
    };
  }
}

module.exports = verificarDiretorio;
