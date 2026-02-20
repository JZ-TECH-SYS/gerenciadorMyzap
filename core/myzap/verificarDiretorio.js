const fs = require('fs');
const { error } = require('../utils/logger');

async function verificarDiretorio(dirPath) {
  try {
    console.log('Verificando diretório:', dirPath);
    if (!dirPath || !fs.existsSync(dirPath)) {
      return {
        status: 'error',
        message: 'MyZap não se encontra no diretório configurado!'
      };
    }

    return {
      status: 'success',
      message: 'MyZap se encontra no diretório configurado!'
    };
  } catch (err) {
    error('Erro ao verificar diretório', {
      metadata: { error: err, area: 'verificarDiretorio' }
    });
    return {
      status: 'error',
      message: err.message || String(err)
    };
  }
}

module.exports = verificarDiretorio;
