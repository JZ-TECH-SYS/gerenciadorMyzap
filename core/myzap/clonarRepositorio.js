const { spawn, execSync } = require('child_process');
const { error: logError } = require('../utils/logger');
const path = require('path');
const fs = require('fs');

/**
 * Executa um comando shell e retorna se foi bem-sucedido
 */
function rodarComando(comando, args, opcoes = {}) {
  return new Promise((resolve) => {
    const proc = spawn(comando, args, { shell: true, ...opcoes });

    proc.stdout.on('data', (data) => console.log(`[${comando}]: ${data}`));
    proc.stderr.on('data', (data) => console.error(`[${comando}-err]: ${data}`));

    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

function pararProcessoPorta() {
  try {
    const stdout = execSync('netstat -ano | findstr :5555').toString();
    const lines = stdout.split('\n');
    if (lines.length > 0) {
      const line = lines[0].trim();
      const parts = line.split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && pid !== '0') {
        console.log(`Matando processo MyZap (PID: ${pid})...`);
        execSync(`taskkill /F /PID ${pid}`);
      }
    }
  } catch (e) {
    console.log('Nenhum processo rodando na porta 5555 ou erro ao finalizar. Erro:', e.message);
  }
}

function verificarDependencia(comando) {
  return new Promise((resolve) => {
    const check = spawn(comando, ['--version'], { shell: true });
    check.on('error', () => resolve(false));
    check.on('close', (code) => resolve(code === 0));
  });
}

function tentarInstalar(programa) {
  const wingetIds = {
    git: 'Git.Git',
    node: 'OpenJS.NodeJS.LTS'
  };
  const id = wingetIds[programa];
  if (!id) return Promise.resolve(false);

  return rodarComando('winget', [
    'install', '--id', id, '-e', '--source', 'winget',
    '--accept-package-agreements', '--accept-source-agreements', '--silent'
  ]);
}

/**
 * Clona o repositório MyZap, instala dependências e inicia o serviço
 * @param {string} dirPath   Caminho destino da instalação
 * @param {string} envContent Conteúdo do arquivo .env
 * @param {boolean} reinstall Se true, remove a instalação existente antes de clonar
 */
async function clonarRepositorio(dirPath, envContent, reinstall = false) {
  try {
    // 1. Verificações de ambiente
    if (!(await verificarDependencia('git'))) {
      if (!(await tentarInstalar('git'))) {
        return { status: 'error', message: 'Falha ao instalar Git.' };
      }
    }
    if (!(await verificarDependencia('node'))) {
      if (!(await tentarInstalar('node'))) {
        return { status: 'error', message: 'Falha ao instalar Node.js.' };
      }
    }

    // 2. Lógica de reinstalação
    if (reinstall) {
      console.log('Iniciando modo de reinstalação...');
      pararProcessoPorta();
      await new Promise((r) => setTimeout(r, 500));

      if (fs.existsSync(dirPath)) {
        try {
          console.log('Removendo pasta via comando do sistema...');
          execSync(`rd /s /q "${dirPath}"`);
        } catch (err) {
          logError('Erro ao deletar pasta via RD', { metadata: { err } });
          if (fs.existsSync(dirPath)) {
            fs.rmSync(dirPath, { recursive: true, force: true });
          }
        }
      }
    }

    // 3. Clone do repositório
    const repoUrl = 'https://github.com/JZ-TECH-SYS/myzap.git';
    console.log('Iniciando clone...');
    const clonou = await rodarComando('git', ['clone', repoUrl, dirPath]);

    if (!clonou) {
      return {
        status: 'error',
        message: 'Erro ao clonar o repositório. Verifique se a pasta já existe.'
      };
    }

    // 4. Instalar pnpm globalmente
    console.log('Instalando pnpm globalmente...');
    const pnpmGlobal = await rodarComando('npm', ['install', '-g', 'pnpm']);
    if (!pnpmGlobal) {
      return { status: 'error', message: 'Falha ao instalar pnpm globalmente.' };
    }

    // 5. Instalar dependências do projeto
    console.log('Instalando dependências do projeto...');
    const instalouDeps = await rodarComando('pnpm', ['install'], { cwd: dirPath });
    if (!instalouDeps) {
      return {
        status: 'error',
        message: 'Repositório clonado, mas houve erro ao instalar dependências (pnpm install).'
      };
    }

    // 6. Configuração de arquivos (.env e banco de dados)
    console.log('Configurando arquivo .env e banco de dados...');

    const envDest = path.join(dirPath, '.env');
    fs.writeFileSync(envDest, envContent, 'utf8');

    const dbOrigem = path.join(__dirname, 'database', 'db.sqlite');
    const dbDestDir = path.join(dirPath, 'database');
    const dbDestFile = path.join(dbDestDir, 'db.sqlite');

    if (!fs.existsSync(dbDestDir)) {
      fs.mkdirSync(dbDestDir, { recursive: true });
    }

    if (fs.existsSync(dbOrigem)) {
      fs.copyFileSync(dbOrigem, dbDestFile);
    } else {
      console.warn('Aviso: Banco de dados original não encontrado em ' + dbOrigem);
    }

    // 7. Iniciar o projeto
    console.log('Iniciando MyZap...');
    rodarComando('pnpm', ['start'], { cwd: dirPath });

    return {
      status: 'success',
      message: 'MyZap instalado, configurado e iniciado com sucesso!'
    };
  } catch (err) {
    logError('Erro crítico no processo de instalação', { metadata: { error: err } });
    return { status: 'error', message: `Erro: ${err.message}` };
  }
}

module.exports = clonarRepositorio;
