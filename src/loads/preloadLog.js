const fs = require('fs');
const path = require('path');
const { clipboard, contextBridge } = require('electron');
const { getLogDir } = require('../../core/utils/logger');

const LOG_DIR = getLogDir();
const TEXT_LEVEL_MAP = {
  erro: 'error',
  aviso: 'warn',
  info: 'info',
  debug: 'debug'
};

function listLogFiles() {
  try {
    return fs.readdirSync(LOG_DIR)
      .filter((file) => file.endsWith('.jsonl'))
      .map((file) => {
        const stats = fs.statSync(path.join(LOG_DIR, file));
        return { name: file, size: stats.size, mtime: stats.mtimeMs };
      });
  } catch (err) {
    console.error('Erro ao listar logs', err);
    return [];
  }
}

async function readLogTail({ filename, maxBytes = 128 * 1024, levelFilters = [], search = '' }) {
  if (!filename) {
    return {
      display: ['Selecione um arquivo válido'],
      meta: { size: 0, mtime: Date.now() },
      truncated: false
    };
  }

  const filePath = path.join(LOG_DIR, filename);
  try {
    const stats = fs.statSync(filePath);
    const start = Math.max(0, stats.size - maxBytes);
    const length = stats.size - start;
    const handle = await fs.promises.open(filePath, 'r');
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    await handle.close();
    const raw = buffer.toString('utf8');

    const lines = raw.split('\n').filter(Boolean);
    const isJson = filename.endsWith('.jsonl');
    const display = lines.filter((line) => matchesFilters(line, levelFilters, search, isJson));

    return {
      display,
      meta: { size: stats.size, mtime: stats.mtimeMs },
      truncated: start > 0
    };
  } catch (err) {
    console.error('Erro ao ler log', err);
    return {
      display: ['Erro ao carregar o log: ' + err.message],
      meta: { size: 0, mtime: Date.now() },
      truncated: false
    };
  }
}

function matchesFilters(line, levelFilters, search, isJson) {
  const sanitizedSearch = (search || '').trim().toLowerCase();
  let levelPass = true;

  if (levelFilters.length) {
    if (isJson) {
      try {
        const parsed = JSON.parse(line);
        levelPass = levelFilters.includes(parsed.level);
      } catch {
        levelPass = true;
      }
    } else {
      const marker = line.match(/\[(\w+)\]/);
      if (marker) {
        const normalized = TEXT_LEVEL_MAP[marker[1].toLowerCase()] || marker[1].toLowerCase();
        levelPass = levelFilters.includes(normalized);
      }
    }
  }

  if (!levelPass) return false;
  if (sanitizedSearch) return line.toLowerCase().includes(sanitizedSearch);
  return true;
}

contextBridge.exposeInMainWorld('logViewer', {
  listLogFiles,
  readLogTail,
  copyText(text = '') {
    clipboard.writeText(String(text));
  }
});
