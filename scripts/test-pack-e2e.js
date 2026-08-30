/**
 * E2E do Runtime Pack em SANDBOX — roda com o Electron de dev:
 *
 *   pnpm exec electron scripts/test-pack-e2e.js [caminho-do-pack.zip]
 *
 * Cenarios (tudo em diretorios temporarios; nada toca instalacao real):
 *   1. INSTALL  — instalacao limpa a partir do pack: motor sobe, /health ok,
 *                 dados nascem em myzap-data\ (.env + db da semente).
 *   2. UPDATE   — manifest instalado e rebaixado para 0.0.1; o mesmo pack
 *                 (mais novo) e aplicado pelo fluxo real de update; um
 *                 marcador plantado em instances\ PROVA que dados sobrevivem.
 *   3. ROLLBACK — um pack v9.9.9 deliberadamente quebrado (index.js sai com
 *                 codigo 1) e aplicado; a troca falha na saude e o motor
 *                 anterior tem que voltar sozinho e ficar saudavel.
 *
 * Sai com codigo 0 somente se os 3 cenarios passarem.
 */

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const packZipArg = process.argv[2]
    || path.join('C:', 'jztech', 'myzap', 'dist-pack', 'myzap-pack-win32-x64.zip');

const results = [];
function report(name, ok, detail = '') {
    results.push({ name, ok, detail });
    console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function assert(cond, name, detail = '') {
    report(name, Boolean(cond), cond ? '' : detail);
    return Boolean(cond);
}

async function fetchLocal(pathname, timeoutMs = 4000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(`http://127.0.0.1:5555${pathname}`, { signal: ctrl.signal });
        const body = await res.json().catch(() => ({}));
        return { status: res.status, body };
    } catch (e) {
        return { status: 0, body: null, error: e.message };
    } finally {
        clearTimeout(t);
    }
}

async function waitHealth(timeoutMs) {
    const start = Date.now();
    for (;;) {
        const r = await fetchLocal('/health');
        if (r.status === 200) return r;
        if (Date.now() - start > timeoutMs) return r;
        await new Promise((res) => { setTimeout(res, 2000); });
    }
}

app.whenReady().then(async () => {
    let exitCode = 1;
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gerenciador-e2e-'));
    console.log(`[e2e] sandbox: ${sandbox}`);
    console.log(`[e2e] pack:    ${packZipArg}`);

    // Isolamento TOTAL: userData proprio => electron-store proprio.
    app.setPath('userData', path.join(sandbox, 'userData'));

    // Requires DEPOIS do setPath (os modulos criam Store no load).
    /* eslint-disable global-require */
    const Store = require('electron-store');
    const store = new Store();
    const enginePack = require('../core/myzap/enginePack');
    const { stopMyZapAndFreePort } = require('../core/myzap/iniciarMyZap');
    const { readEngineManifest, getDataDirFor } = require('../core/myzap/enginePaths');
    const clonarRepositorio = require('../core/myzap/clonarRepositorio');
    /* eslint-enable global-require */

    const engineDir = path.join(sandbox, 'inst', 'myzap');
    const dataDir = getDataDirFor(engineDir);

    store.set({
        apiUrl: 'http://127.0.0.1:9/',
        apiToken: 'fake',
        idempresa: '1',
        myzap_diretorio: engineDir,
        myzap_sessionKey: 'teste_e2e',
        myzap_sessionName: 'teste_e2e',
        myzap_apiToken: 'fake-token'
    });

    process.env.GERENCIADOR_PACK_ZIP = packZipArg;

    try {
        if (!fs.existsSync(packZipArg)) {
            report('pack existe', false, `nao encontrado: ${packZipArg}`);
            throw new Error('sem pack');
        }

        /* ── 1. INSTALL ─────────────────────────────────────── */
        console.log('\n[e2e] cenario 1: instalacao limpa via pack');
        const install = await clonarRepositorio(engineDir, '', false, {});
        assert(install?.status === 'success', '1. instalacao via pack', install?.message || '');

        const manifest1 = readEngineManifest(engineDir);
        assert(manifest1?.version, '1. manifest instalado', JSON.stringify(manifest1 || {}));
        if (!manifest1?.version) {
            throw new Error('instalacao nao veio do pack (provavel fallback legado) — cenarios 2/3 nao fazem sentido');
        }
        assert(fs.existsSync(path.join(engineDir, 'node', 'node.exe')), '1. node embutido presente');
        assert(fs.existsSync(path.join(dataDir, '.env')), '1. .env no diretorio de dados');
        assert(fs.existsSync(path.join(dataDir, 'database', 'db.sqlite')), '1. banco semente no diretorio de dados');
        assert(!fs.existsSync(path.join(engineDir, '.env')), '1. .env NAO fica dentro do motor');

        const h1 = await waitHealth(30000);
        assert(h1.status === 200, '1. /health responde 200', JSON.stringify(h1));
        assert(h1.body?.engine !== undefined || h1.body?.status === 'ok', '1. /health com payload esperado');

        /* ── 2. UPDATE (mesmo pack, manifest rebaixado) ─────── */
        console.log('\n[e2e] cenario 2: update com dados preservados');
        const marker = path.join(dataDir, 'instances', 'MARCADOR-E2E.txt');
        fs.mkdirSync(path.dirname(marker), { recursive: true });
        fs.writeFileSync(marker, 'sessao-do-cliente');

        const downgraded = { ...manifest1, version: '0.0.1' };
        fs.writeFileSync(path.join(engineDir, 'manifest.json'), JSON.stringify(downgraded, null, 2));

        const update = await enginePack.checkAndUpdatePack();
        assert(update?.status === 'success', '2. update aplicado', update?.message || JSON.stringify(update));
        const manifest2 = readEngineManifest(engineDir);
        assert(manifest2?.version === manifest1.version, '2. versao final correta', `esperava ${manifest1.version}, veio ${manifest2?.version}`);
        assert(fs.existsSync(marker), '2. dados (instances) PRESERVADOS no update');
        assert(!fs.existsSync(`${engineDir}.old`), '2. .old limpo apos sucesso');

        const h2 = await waitHealth(30000);
        assert(h2.status === 200, '2. servico saudavel pos-update');

        /* ── 3. ROLLBACK (pack quebrado) ────────────────────── */
        console.log('\n[e2e] cenario 3: pack quebrado deve reverter sozinho');
        const brokenDir = path.join(sandbox, 'broken-pack');
        fs.mkdirSync(path.join(brokenDir, 'node_modules', 'express'), { recursive: true });
        fs.writeFileSync(path.join(brokenDir, 'node_modules', 'express', 'index.js'), 'module.exports={}');
        fs.writeFileSync(path.join(brokenDir, 'index.js'), 'console.error("pack quebrado de proposito");process.exit(1);');
        fs.writeFileSync(path.join(brokenDir, 'package.json'), '{"name":"myzap","version":"9.9.9"}');
        fs.writeFileSync(path.join(brokenDir, 'manifest.json'), JSON.stringify({
            schema: 1, name: 'myzap-pack', version: '9.9.9', platform: `${process.platform}-${process.arch}`
        }));
        // node embutido copiado do motor bom (o quebrado precisa "tentar" subir)
        fs.mkdirSync(path.join(brokenDir, 'node'), { recursive: true });
        fs.copyFileSync(path.join(engineDir, 'node', 'node.exe'), path.join(brokenDir, 'node', 'node.exe'));

        const brokenZip = path.join(sandbox, 'myzap-pack-win32-x64.zip');
        execSync(`"${path.join(process.env.SystemRoot || 'C\\:\\Windows', 'System32', 'tar.exe')}" -a -cf "${brokenZip}" -C "${brokenDir}" .`);
        fs.writeFileSync(brokenZip.replace(/\.zip$/, '.manifest.json'), JSON.stringify({
            schema: 1, name: 'myzap-pack', version: '9.9.9', platform: `${process.platform}-${process.arch}`
        }));
        process.env.GERENCIADOR_PACK_ZIP = brokenZip;

        const broken = await enginePack.checkAndUpdatePack();
        assert(broken?.status === 'error', '3. update quebrado reportou erro', JSON.stringify(broken));
        assert(broken?.rolledBack === true, '3. rollback executado', JSON.stringify(broken));
        const manifest3 = readEngineManifest(engineDir);
        assert(manifest3?.version === manifest1.version, '3. motor voltou para a versao boa', `veio ${manifest3?.version}`);
        assert(fs.existsSync(marker), '3. dados intactos apos rollback');

        const h3 = await waitHealth(45000);
        assert(h3.status === 200, '3. servico saudavel pos-rollback');

        exitCode = results.every((r) => r.ok) ? 0 : 1;
    } catch (err) {
        console.error('[e2e] excecao:', err);
        exitCode = 1;
    } finally {
        console.log('\n[e2e] encerrando servico e limpando sandbox...');
        try { await stopMyZapAndFreePort({ timeoutMs: 10000 }); } catch (_e) { /* */ }
        try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_e) { /* */ }
        const passed = results.filter((r) => r.ok).length;
        console.log(`\n[e2e] RESULTADO: ${passed}/${results.length} asserts OK — ${exitCode === 0 ? 'SUCESSO' : 'FALHA'}`);
        app.exit(exitCode);
    }
});
