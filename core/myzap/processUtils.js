const { execSync, spawn } = require('child_process');
const net = require('net');
const os = require('os');

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
            { stdio: ['ignore', 'pipe', 'pipe'] }
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
            { stdio: ['ignore', 'pipe', 'pipe'] }
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
            { stdio: ['ignore', 'pipe', 'pipe'] }
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
        failed
    };
}

function commandExists(command) {
    return new Promise((resolve) => {
        const checker = os.platform() === 'win32' ? 'where' : 'which';
        const child = spawn(checker, [command], { shell: false });
        child.on('error', () => resolve(false));
        child.on('close', (code) => resolve(code === 0));
    });
}

async function getPnpmCommand() {
    if (await commandExists('pnpm')) {
        return { command: 'pnpm', prefixArgs: [] };
    }

    // npx vem com o npm e e a forma mais comum de rodar pnpm sem instalar globalmente
    if (await commandExists('npx')) {
        return { command: 'npx', prefixArgs: ['pnpm'] };
    }

    // npm disponivel mas npx nao (npm < 5.2) — tenta via npm exec
    if (await commandExists('npm')) {
        return { command: 'npm', prefixArgs: ['exec', 'pnpm', '--'] };
    }

    return null;
}

module.exports = {
    isPortInUse,
    killProcessesOnPort,
    commandExists,
    getPnpmCommand
};
