const { execSync, spawn, spawnSync } = require('child_process');
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');

const DEFAULT_LOCAL_HTTP_URLS = ['http://127.0.0.1:5555/', 'http://localhost:5555/'];

function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true);
      } else {
        resolve(false);
      }
    });

    server.once('listening', () => {
      server.close();
      resolve(false);
    });

    server.listen(port);
  });
}

function parsePids(text) {
  const pids = new Set();
  const matches = String(text || '').match(/\b\d+\b/g) || [];
  for (const match of matches) {
    const pid = Number(match);
    if (Number.isInteger(pid) && pid > 0) {
      pids.add(pid);
    }
  }
  return [...pids];
}

function parsePidsByLine(text) {
  const pids = new Set();
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (/^\d+$/.test(line)) {
      const pid = Number(line);
      if (pid > 0) {
        pids.add(pid);
      }
    }
  }
  return [...pids];
}

function getPidsOnPortWindows(port) {
  try {
    const stdout = execSync(`netstat -ano | findstr :${port}`, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const pids = new Set();
    const ownPid = process.pid;
    for (const line of lines) {
      const parts = line.split(/\s+/);
      // Estrutura esperada do netstat:
      // Proto  EnderecoLocal  EnderecoRemoto  Estado  PID
      // Somente matar o processo que POSSUI a porta (endereco local),
      // nao processos com conexoes de SAIDA para essa porta.
      // Ex. de linha invalida: "TCP 127.0.0.1:62345 127.0.0.1:5555 ESTABLISHED 1001"
      //   onde 127.0.0.1:62345 e o lado do cliente (Electron) — nao deve ser morto.
      const localAddr = parts[1] || '';
      if (!localAddr.endsWith(`:${port}`)) {
        continue; // ignorar conexoes de saida para a porta
      }
      const pid = Number(parts[parts.length - 1]);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      if (pid === ownPid) continue; // nunca matar o proprio processo
      pids.add(pid);
    }
    return [...pids];
  } catch (_e) {
    return [];
  }
}

function getPidsOnPortUnix(port) {
  const ownPid = process.pid;

  // Tenta lsof com filtro TCP:LISTEN (evita retornar clientes conectados a porta,
  // como o proprio Electron fazendo requisicoes HTTP ao MyZap)
  try {
    const stdout = execSync(
      `lsof -ti "TCP:${port}" -sTCP:LISTEN`,
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString();
    const pids = parsePidsByLine(stdout).filter((pid) => pid !== ownPid);
    if (pids.length > 0) return pids;
  } catch (_e) {
    // tenta fuser
  }

  // Tenta fuser (retorna apenas processos usando a porta TCP, lado servidor)
  try {
    const stdout = execSync(
      `fuser ${port}/tcp 2>/dev/null`,
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString();
    const afterColon = stdout.includes(':') ? stdout.split(':').pop() : stdout;
    const pids = parsePids(afterColon).filter((pid) => pid !== ownPid);
    if (pids.length > 0) return pids;
  } catch (_e) {
    // tenta ss
  }

  // Tenta ss — disponivel em praticamente todos os Linux modernos sem lsof/fuser
  // (Ubuntu 22+, Debian 12+, Alpine, etc.)
  try {
    const stdout = execSync(
      `ss -tlnp 2>/dev/null | grep ' :${port} '`,
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString();
    const pids = new Set();
    for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
      const matches = line.match(/pid=(\d+)/g) || [];
      for (const m of matches) {
        const pid = Number(m.replace('pid=', ''));
        if (pid > 0 && pid !== ownPid) pids.add(pid);
      }
    }
    if (pids.size > 0) return [...pids];
  } catch (_e) {
    // sem pids
  }

  return [];
}

function getPidsOnPort(port) {
  return os.platform() === 'win32'
    ? getPidsOnPortWindows(port)
    : getPidsOnPortUnix(port);
}

function killPid(pid) {
  if (!pid || pid <= 0) {
    return false;
  }

  // Nunca matar o proprio processo (segurança contra netstat falso-positivo)
  if (pid === process.pid) {
    return false;
  }

  try {
    if (os.platform() === 'win32') {
      execSync(`taskkill /T /F /PID ${pid}`, { stdio: ['ignore', 'pipe', 'pipe'] });
    } else {
      execSync(`kill -9 ${pid}`, { stdio: ['ignore', 'pipe', 'pipe'] });
    }
    return true;
  } catch (_e) {
    return false;
  }
}

function killProcessesOnPort(port) {
  const pids = getPidsOnPort(port);
  const killed = [];
  const failed = [];

  for (const pid of pids) {
    if (killPid(pid)) {
      killed.push(pid);
    } else {
      failed.push(pid);
    }
  }

  return {
    pids,
    killed,
    failed,
  };
}

/**
 * Caminhos conhecidos de instalacao no Windows.
 * Usado como fallback quando `where` falha (PATH desatualizado).
 */
const KNOWN_PATHS_WIN = {
  git: [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'cmd', 'git.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'cmd', 'git.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'cmd', 'git.exe'),
  ],
  node: [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', 'node.exe'),
  ],
};

function isElectronPackagedApp() {
  return Boolean(
    process.versions
    && process.versions.electron
    && !process.defaultApp
    && process.resourcesPath,
  );
}

function ensureDirectoryInPath(filePath) {
  if (!filePath) {
    return;
  }

  const dir = path.dirname(filePath);
  const separator = os.platform() === 'win32' ? ';' : ':';
  const currentPath = String(process.env.PATH || '');
  const currentEntries = currentPath.split(separator).filter(Boolean);

  if (!currentEntries.includes(dir)) {
    process.env.PATH = currentPath ? `${dir}${separator}${currentPath}` : dir;
  }
}

function getKnownCommandPath(command) {
  if (os.platform() !== 'win32') {
    return null;
  }

  const knownPaths = KNOWN_PATHS_WIN[command] || [];
  const existingPath = knownPaths.find((filePath) => {
    try {
      return fs.existsSync(filePath);
    } catch (_err) {
      return false;
    }
  });

  if (existingPath) {
    ensureDirectoryInPath(existingPath);
  }

  return existingPath || null;
}

function normalizeBaseUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  return value.endsWith('/') ? value : `${value}/`;
}

function uniqueUrls(urls = []) {
  const output = [];
  const seen = new Set();

  urls.forEach((rawUrl) => {
    const normalized = normalizeBaseUrl(rawUrl);
    if (!normalized) {
      return;
    }

    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    output.push(normalized);
  });

  return output;
}

function runSyncCommand(command, args = []) {
  try {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
    });

    return {
      ok: !result.error && result.status === 0,
      status: result.status,
      stdout: String(result.stdout || '').trim(),
      stderr: String(result.stderr || '').trim(),
      error: result.error || null,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      stdout: '',
      stderr: '',
      error,
    };
  }
}

function detectWindowsElevation() {
  const powershellResult = runSyncCommand('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    '[Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent() | ForEach-Object { $_.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }',
  ]);

  if (/^true$/i.test(powershellResult.stdout)) {
    return { isElevated: true, method: 'powershell' };
  }

  if (/^false$/i.test(powershellResult.stdout)) {
    return { isElevated: false, method: 'powershell' };
  }

  const fltmcResult = runSyncCommand('fltmc');
  if (fltmcResult.ok) {
    return { isElevated: true, method: 'fltmc' };
  }

  const fltmcOutput = `${fltmcResult.stdout}\n${fltmcResult.stderr}`.toLowerCase();
  if (
    fltmcOutput.includes('access is denied')
    || fltmcOutput.includes('acesso negado')
    || fltmcOutput.includes('privilege')
  ) {
    return { isElevated: false, method: 'fltmc' };
  }

  const netSessionResult = runSyncCommand('net', ['session']);
  if (netSessionResult.ok) {
    return { isElevated: true, method: 'net-session' };
  }

  const netOutput = `${netSessionResult.stdout}\n${netSessionResult.stderr}`.toLowerCase();
  if (
    netOutput.includes('access is denied')
    || netOutput.includes('acesso negado')
    || netOutput.includes('privilege')
  ) {
    return { isElevated: false, method: 'net-session' };
  }

  return { isElevated: false, method: 'fallback_unknown' };
}

function buildAdminRequiredMessage(action = 'instalar ou reinstalar o MyZap local') {
  return `Para ${action}, feche o Gerenciador MyZap e abra novamente como Administrador.`;
}

function getPrivilegeStatus() {
  const platform = os.platform();

  if (platform === 'win32') {
    const detected = detectWindowsElevation();
    const needsAdminForLocalInstall = !detected.isElevated;

    return {
      platform,
      isElevated: Boolean(detected.isElevated),
      requiresAdminForLocalInstall: true,
      needsAdminForLocalInstall,
      method: detected.method || 'unknown',
      message: needsAdminForLocalInstall ? buildAdminRequiredMessage() : '',
    };
  }

  if (typeof process.getuid === 'function') {
    return {
      platform,
      isElevated: process.getuid() === 0,
      requiresAdminForLocalInstall: false,
      needsAdminForLocalInstall: false,
      method: 'getuid',
      message: '',
    };
  }

  return {
    platform,
    isElevated: false,
    requiresAdminForLocalInstall: false,
    needsAdminForLocalInstall: false,
    method: 'unsupported',
    message: '',
  };
}

function resolveCommandPath(command) {
  return new Promise((resolve) => {
    const checker = os.platform() === 'win32' ? 'where' : 'which';
    const child = spawn(checker, [command], {
      shell: false,
      windowsHide: true,
    });
    let stdout = '';

    const resolveKnownPath = () => {
      resolve(getKnownCommandPath(command));
    };

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.on('error', resolveKnownPath);
    child.on('close', (code) => {
      if (code === 0) {
        const resolvedPath = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean);

        if (resolvedPath) {
          ensureDirectoryInPath(resolvedPath);
          resolve(resolvedPath);
          return;
        }
      }

      resolveKnownPath();
    });
  });
}

async function isLocalHttpServiceReachable(options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 2500;
  const baseUrls = uniqueUrls([...(options.baseUrls || []), ...DEFAULT_LOCAL_HTTP_URLS]);
  let index = 0;

  while (index < baseUrls.length) {
    const baseUrl = baseUrls[index];
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);

    try {
      await fetch(baseUrl, {
        method: 'GET',
        signal: abort.signal,
      });
      clearTimeout(timer);
      return true;
    } catch (_err) {
      clearTimeout(timer);
      index += 1;
    }
  }

  return false;
}

function resolveAsarUnpackedPath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return filePath;
  }

  const asarSegment = `${path.sep}app.asar${path.sep}`;
  if (!filePath.includes(asarSegment)) {
    return filePath;
  }

  const unpackedPath = filePath.replace(asarSegment, `${path.sep}app.asar.unpacked${path.sep}`);
  return fs.existsSync(unpackedPath) ? unpackedPath : filePath;
}

function getBundledPnpmCommand() {
  try {
    const packageJsonPath = require.resolve('pnpm');
    const cliPath = resolveAsarUnpackedPath(path.join(path.dirname(packageJsonPath), 'bin', 'pnpm.cjs'));
    if (isElectronPackagedApp() && cliPath.includes(`${path.sep}app.asar${path.sep}`)) {
      return null;
    }

    if (!fs.existsSync(cliPath)) {
      return null;
    }

    return {
      command: process.execPath,
      prefixArgs: [cliPath],
      shell: false,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
      },
      source: 'bundled-pnpm',
    };
  } catch (_err) {
    return null;
  }
}

async function commandExists(command) {
  return Boolean(await resolveCommandPath(command));
}

/**
 * Atualiza o PATH do processo atual lendo o registro do Windows.
 * Expande variaveis de ambiente (%SystemRoot%, %ProgramFiles% etc.)
 */
function refreshPathWindows() {
  try {
    const systemPath = execSync(
      'reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v Path',
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString();

    const userPath = execSync(
      'reg query "HKCU\\Environment" /v Path',
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString();

    const extractValue = (regOutput) => {
      const match = regOutput.match(/REG_(?:EXPAND_)?SZ\s+(.+)/i);
      return match ? match[1].trim() : '';
    };

    const expandVars = (str) => str.replace(/%([^%]+)%/g, (_, varName) => process.env[varName] || `%${varName}%`);

    const newPathStr = [extractValue(systemPath), extractValue(userPath)]
      .filter(Boolean)
      .map(expandVars)
      .join(';');

    if (newPathStr) {
      process.env.PATH = newPathStr;
    }
  } catch (_err) { /* melhor esforco */ }
}

async function getPnpmCommand() {
  const bundledRunner = getBundledPnpmCommand();
  if (bundledRunner) {
    return bundledRunner;
  }

  if (isElectronPackagedApp()) {
    return null;
  }

  const pnpmPath = await resolveCommandPath('pnpm');
  if (pnpmPath) {
    return {
      command: pnpmPath,
      prefixArgs: [],
      shell: false,
      env: process.env,
      source: 'system-pnpm',
    };
  }

  // npx vem com o npm e e a forma mais comum de rodar pnpm sem instalar globalmente
  const npxPath = await resolveCommandPath('npx');
  if (npxPath) {
    return {
      command: npxPath,
      prefixArgs: ['pnpm'],
      shell: false,
      env: process.env,
      source: 'system-npx',
    };
  }

  // npm disponivel mas npx nao (npm < 5.2) — tenta via npm exec
  const npmPath = await resolveCommandPath('npm');
  if (npmPath) {
    return {
      command: npmPath,
      prefixArgs: ['exec', 'pnpm', '--'],
      shell: false,
      env: process.env,
      source: 'system-npm-exec',
    };
  }

  return null;
}

async function getGitCommand() {
  const gitPath = await resolveCommandPath('git');
  if (!gitPath) {
    return null;
  }

  return {
    command: gitPath,
    prefixArgs: [],
    shell: false,
    env: process.env,
    source: 'system-git',
  };
}

module.exports = {
  isPortInUse,
  isLocalHttpServiceReachable,
  killProcessesOnPort,
  getPrivilegeStatus,
  buildAdminRequiredMessage,
  commandExists,
  resolveCommandPath,
  getPnpmCommand,
  getGitCommand,
  refreshPathWindows,
};
