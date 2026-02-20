const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const iniciarMyZap = require('./iniciarMyZap');
const { info, error } = require('../utils/logger');

/**
 * Atualiza o .env e reinicia o serviço MyZap
 */
async function atualizarEnv(dirPath, envContent) {
  try {
    const envPath = path.join(dirPath, '.env');

    if (!fs.existsSync(dirPath)) {
      return { status: 'error', message: 'Projeto não instalado no diretório informado.' };
    }

    fs.writeFileSync(envPath, envContent, 'utf8');
    info('Arquivo .env atualizado com sucesso.');

    // Mata o processo na porta 5555 para garantir o restart
    try {
      const stdout = execSync('netstat -ano | findstr :5555').toString();
      const pid = stdout.split(/\s+/).filter(Boolean).pop();

      if (pid && pid !== '0') {
        info(`Reiniciando MyZap: Finalizando processo antigo (PID: ${pid})`);
        execSync(`taskkill /F /PID ${pid}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (_e) {
      // Porta já estava livre — não faz nada
    }

    const result = await iniciarMyZap(dirPath);

    return {
      status: 'success',
      message: 'Configurações aplicadas e serviço reiniciado!'
    };
  } catch (err) {
    error('Erro ao atualizar .env', { metadata: { error: err } });
    return { status: 'error', message: `Erro ao atualizar: ${err.message}` };
  }
}

module.exports = atualizarEnv;
