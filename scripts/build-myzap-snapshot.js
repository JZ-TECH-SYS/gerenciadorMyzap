#!/usr/bin/env node
/**
 * Monta o SNAPSHOT OFFLINE do MyZap que vai embutido no instalador.
 *
 * Produz em build/snapshot/:
 *   - myzap-snapshot.zip   -> MyZap PRONTO PARA RODAR: codigo pinado por SHA,
 *                             node_modules ja instalado (node-linker=hoisted,
 *                             sem junctions => diretorio movivel) e Chromium
 *                             do puppeteer DENTRO do pacote (.puppeteer-cache).
 *   - myzap-snapshot.json  -> manifest (sha, plataforma, receita).
 *
 * No cliente, o primeiro boot apenas EXTRAI o zip: sem rede, sem pnpm, sem
 * lifecycle scripts, sem compilacao nativa — as tres coisas que quebravam o
 * setup em "alguns computadores" (proxy/antivirus/sem toolchain).
 *
 * Por que pnpm@9.15.4: e o packageManager declarado pelo MyZap; o pnpm 10
 * embutido no app delega para ele de qualquer forma. Instalar com ele no CI
 * reproduz fielmente o ambiente que ja roda nos clientes hoje.
 *
 * Uso:
 *   node scripts/build-myzap-snapshot.js [--ref <branch|sha>] [--skip-browser] [--keep-work]
 *
 * Roda no CI (windows-latest) e em maquina de dev. Binarios nativos ficam da
 * plataforma onde o script roda — o manifest grava a plataforma e o runtime
 * ignora snapshot de plataforma errada.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const REPO = 'JZ-TECH-SYS/myzap';
const PNPM_VERSION = '9.15.4';
const MAX_REDIRECTS = 5;

const repoRoot = path.resolve(__dirname, '..');
const outDir = path.join(repoRoot, 'build', 'snapshot');
const workDir = path.join(outDir, '.work');
const zipPath = path.join(outDir, 'myzap-snapshot.zip');
const manifestPath = path.join(outDir, 'myzap-snapshot.json');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const ref = opt('--ref', 'main');
const skipBrowser = flag('--skip-browser');
const keepWork = flag('--keep-work');

function log(msg) {
  process.stdout.write(`[snapshot] ${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`[snapshot] ERRO: ${msg}\n`);
  process.exit(1);
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function httpGet(url, { headers = {}, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'gerenciador-myzap-snapshot', ...headers },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) {
          reject(new Error(`redirecionamentos demais para ${url}`));
          return;
        }
        const next = new URL(res.headers.location, url).toString();
        httpGet(next, { headers, redirects: redirects + 1 }).then(resolve, reject);
        return;
      }
      resolve(res);
    });
    req.setTimeout(60000, () => req.destroy(new Error(`timeout ao baixar ${url}`)));
    req.on('error', reject);
  });
}

async function readBody(res) {
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** SHA do ref na API do GitHub (usa GITHUB_TOKEN se presente, evita rate limit no CI). */
async function fetchSha(refName) {
  const headers = { Accept: 'application/vnd.github.sha' };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const res = await httpGet(`https://api.github.com/repos/${REPO}/commits/${refName}`, { headers });
  if (res.statusCode !== 200) {
    res.resume();
    return null;
  }
  const sha = (await readBody(res)).trim();
  return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
}

async function downloadZip(refName, dest) {
  const url = `https://codeload.github.com/${REPO}/zip/${refName}`;
  log(`baixando ${url}`);
  const res = await httpGet(url);
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`download do MyZap falhou (HTTP ${res.statusCode})`);
  }
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    res.pipe(out);
    out.on('finish', () => out.close(resolve));
    out.on('error', reject);
    res.on('error', reject);
  });
}

function run(cmd, cmdArgs, options = {}) {
  log(`$ ${cmd} ${cmdArgs.join(' ')}`);
  // No Windows com shell:true os args sao concatenados sem escape: caminhos
  // com espaco (C:\Users\Joao Vitor\...) quebrariam sem as aspas.
  const winShell = process.platform === 'win32' && options.shell;
  const quote = (v) => (/\s/.test(String(v)) ? `"${v}"` : String(v));
  const finalCmd = winShell ? quote(cmd) : cmd;
  const finalArgs = winShell ? cmdArgs.map(quote) : cmdArgs;
  const result = spawnSync(finalCmd, finalArgs, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  return result.status === 0;
}

function commandWorks(cmd, cmdArgs) {
  try {
    const r = spawnSync(cmd, cmdArgs, { stdio: 'ignore', shell: process.platform === 'win32' });
    return !r.error && r.status === 0;
  } catch (_e) {
    return false;
  }
}

/**
 * Extrai um zip via CLI da plataforma. NAO usa extract-zip aqui de proposito:
 * o yauzl pendura em Node >= 24 (promise nunca resolve e o processo sai com 0)
 * e este script roda no Node de quem builda — CLI e imune a isso. No runtime
 * do cliente o extract-zip segue OK (Electron 40 = Node 22, comprovado em
 * producao pelo repositoryArchive).
 */
function unzipTo(zipFile, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (process.platform === 'win32') {
    if (run('tar', ['-xf', zipFile, '-C', destDir], { shell: true })) return;
    throw new Error('tar.exe falhou ao extrair o zip');
  }
  if (commandWorks('unzip', ['-v'])) {
    if (run('unzip', ['-q', zipFile, '-d', destDir])) return;
    throw new Error('unzip falhou ao extrair o arquivo');
  }
  if (run('python3', ['-m', 'zipfile', '-e', zipFile, destDir])) return;
  throw new Error('nenhum extrator disponivel (tar/unzip/python3)');
}

/**
 * Cria o zip com o CONTEUDO de pkgDir na raiz do arquivo.
 * Windows: tar.exe nativo (bsdtar entende .zip). Linux/mac: zip; fallback
 * python3 zipfile (listando as entradas top-level para nao criar prefixo).
 */
function zipDirectory(pkgDir, destZip) {
  rmrf(destZip);
  if (process.platform === 'win32') {
    if (run('tar', ['-a', '-cf', destZip, '-C', pkgDir, '.'], { shell: true })) return;
    throw new Error('tar.exe falhou ao criar o zip');
  }
  if (commandWorks('zip', ['-v'])) {
    if (run('zip', ['-qry', destZip, '.'], { cwd: pkgDir })) return;
    throw new Error('zip falhou ao criar o arquivo');
  }
  const entries = fs.readdirSync(pkgDir);
  if (run('python3', ['-m', 'zipfile', '-c', destZip, ...entries], { cwd: pkgDir })) return;
  throw new Error('nenhum zipador disponivel (tar/zip/python3)');
}

async function main() {
  log(`plataforma: ${process.platform}-${process.arch} | ref: ${ref}${skipBrowser ? ' | SEM browser' : ''}`);

  fs.mkdirSync(outDir, { recursive: true });
  rmrf(workDir);
  fs.mkdirSync(workDir, { recursive: true });

  // 1) resolver SHA (pina a versao exata; sem SHA o runtime adota baseline depois)
  const sha = /^[0-9a-f]{40}$/i.test(ref) ? ref.toLowerCase() : await fetchSha(ref);
  if (!sha) {
    log('AVISO: nao consegui resolver o SHA (API do GitHub). Snapshot seguira sem SHA pinado.');
  } else {
    log(`SHA pinado: ${sha}`);
  }

  // 2) baixar e extrair o codigo
  const codeZip = path.join(workDir, 'code.zip');
  await downloadZip(sha || ref, codeZip);
  log('extraindo codigo...');
  unzipTo(codeZip, workDir);

  const extractedRoot = fs.readdirSync(workDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.toLowerCase().startsWith('myzap-'))
    .map((e) => e.name)[0];
  if (!extractedRoot) fail('estrutura extraida invalida (sem diretorio myzap-*)');

  const pkgDir = path.join(workDir, 'pkg');
  fs.renameSync(path.join(workDir, extractedRoot), pkgDir);
  fs.rmSync(codeZip, { force: true });

  // 3) node_modules movivel: hoisted (flat, sem junctions absolutas do pnpm)
  fs.writeFileSync(path.join(pkgDir, '.npmrc'), 'node-linker=hoisted\n');

  // 4) install com o pnpm que o MyZap declara; Chromium vai para DENTRO do pacote
  const env = {
    ...process.env,
    PUPPETEER_CACHE_DIR: path.join(pkgDir, '.puppeteer-cache'),
    // o headless "shell" nao e usado (engines usam headless novo) — economiza ~120MB
    PUPPETEER_SKIP_CHROME_HEADLESS_SHELL_DOWNLOAD: 'true',
  };
  if (skipBrowser) env.PUPPETEER_SKIP_DOWNLOAD = 'true';

  const okInstall = run('npx', ['-y', `pnpm@${PNPM_VERSION}`, 'install', '--no-frozen-lockfile'], {
    cwd: pkgDir,
    shell: true,
    env,
  });
  if (!okInstall) fail('pnpm install falhou');

  // 5) sanidade: o pacote precisa estar APTO A RODAR
  const precisaExistir = [
    'index.js',
    'package.json',
    path.join('node_modules', 'express'),
    path.join('node_modules', 'whatsapp-web.js'),
    path.join('node_modules', 'sqlite3'),
  ];
  for (const rel of precisaExistir) {
    if (!fs.existsSync(path.join(pkgDir, rel))) fail(`sanidade falhou: falta ${rel}`);
  }
  if (!skipBrowser && !fs.existsSync(path.join(pkgDir, '.puppeteer-cache', 'chrome'))) {
    fail('sanidade falhou: Chromium nao foi baixado para .puppeteer-cache/chrome');
  }

  // 6) zip + manifest
  log('compactando snapshot...');
  zipDirectory(pkgDir, zipPath);
  const sizeBytes = fs.statSync(zipPath).size;

  const manifest = {
    sha: sha || null,
    ref,
    generatedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    pnpmVersion: PNPM_VERSION,
    nodeLinker: 'hoisted',
    chromiumEmbedded: !skipBrowser,
    sizeBytes,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  if (!keepWork) rmrf(workDir);

  log(`OK: ${zipPath} (${(sizeBytes / 1024 / 1024).toFixed(1)} MB)`);
  log(`manifest: ${JSON.stringify(manifest)}`);
}

main().catch((err) => fail(err && err.stack ? err.stack : String(err)));
