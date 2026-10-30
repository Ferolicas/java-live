'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createServer } = require('../server');

const javaHome = process.env.JAVA_HOME_DIRECT || process.env.JAVA_HOME || '';
const javac = javaHome ? path.join(javaHome, 'bin', 'javac') : 'javac';
const hasJdk = spawnSync(javac, ['-version']).status === 0;

async function withServer(opts, fn) {
  const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jl-test-'));
  const server = createServer({ mode: 'direct', jobsDir, javaHome, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { await new Promise((r) => server.close(r)); fs.rmSync(jobsDir, { recursive: true, force: true }); }
}
const post = (base, body, headers = {}) => fetch(`${base}/api/run`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('health y archivos estáticos (con cabeceras de seguridad)', async () => {
  await withServer({}, async (base) => {
    const h = await (await fetch(`${base}/api/health`)).json();
    assert.equal(h.ok, true);
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  });
});

test('no sirve nada fuera de public (path traversal)', async () => {
  await withServer({}, async (base) => {
    for (const p of ['/../server.js', '/..%2fserver.js', '/%2e%2e/package.json', '/vendor/../../server.js']) {
      const r = await fetch(`${base}${p}`);
      assert.equal(r.status, 404, p);
    }
  });
});

test('validación y métodos', async () => {
  await withServer({}, async (base) => {
    assert.equal((await post(base, { code: '' })).status, 400);
    assert.equal((await fetch(`${base}/api/run`)).status, 405);
    assert.equal((await fetch(`${base}/api/run`, { method: 'POST', body: '{}' })).status, 415);
    assert.equal((await fetch(`${base}/api/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{no json' })).status, 400);
    assert.equal((await post(base, { code: 'x'.repeat(200_000) }).catch(() => ({ status: 413 }))).status, 413);
  });
});

test('limita las ejecuciones por IP', async () => {
  await withServer({ burst: 2, perSecond: 0 }, async (base) => {
    await post(base, { code: '' });
    await post(base, { code: '' });
    const r = await post(base, { code: '' });
    assert.equal(r.status, 429);
  });
});

test('X-Real-IP solo se acepta desde loopback y separa las cuentas por IP', async () => {
  await withServer({ burst: 1, perSecond: 0 }, async (base) => {
    assert.equal((await post(base, { code: '' }, { 'x-real-ip': '9.9.9.9' })).status, 400);
    assert.equal((await post(base, { code: '' }, { 'x-real-ip': '9.9.9.9' })).status, 429);
    assert.equal((await post(base, { code: '' }, { 'x-real-ip': '8.8.8.8' })).status, 400);
  });
});

test('compila y ejecuta con entrada estándar', { skip: !hasJdk && 'sin JDK' }, async () => {
  await withServer({}, async (base) => {
    const code = 'import java.util.*;\npublic class Saludo { public static void main(String[] a){ Scanner s=new Scanner(System.in); System.out.println("Hola "+s.nextLine()); System.err.println("aviso"); } }';
    const r = await (await post(base, { code, stdin: 'Ferney\n' })).json();
    assert.equal(r.fileName, 'Saludo.java');
    assert.equal(r.compile.ok, true);
    assert.equal(r.run.stdout, 'Hola Ferney\n');
    assert.equal(r.run.stderr, 'aviso\n');
    assert.equal(r.run.code, 0);
  });
});

test('devuelve los errores de compilación con su línea', { skip: !hasJdk && 'sin JDK' }, async () => {
  await withServer({}, async (base) => {
    const r = await (await post(base, { code: 'public class Main {\n  public static void main(String[] a){\n    int x = "hola";\n  }\n}' })).json();
    assert.equal(r.compile.ok, false);
    assert.match(r.compile.output, /Main\.java:3: error/);
    assert.equal(r.run, undefined);
  });
});

test('código con package se ejecuta', { skip: !hasJdk && 'sin JDK' }, async () => {
  await withServer({}, async (base) => {
    const r = await (await post(base, { code: 'package a.b;\npublic class P { public static void main(String[] x){ System.out.println("ok"); } }' })).json();
    assert.equal(r.run.stdout, 'ok\n');
  });
});

test('un bucle infinito se corta por tiempo', { skip: !hasJdk && 'sin JDK', timeout: 20_000 }, async () => {
  await withServer({}, async (base) => {
    const r = await (await post(base, { code: 'public class Main { public static void main(String[] a){ while(true){} } }' })).json();
    assert.equal(r.run.timedOut, true);
  });
});

test('una salida enorme se trunca', { skip: !hasJdk && 'sin JDK', timeout: 20_000 }, async () => {
  await withServer({}, async (base) => {
    const r = await (await post(base, { code: 'public class Main { public static void main(String[] a){ while(true) System.out.println("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"); } }' })).json();
    assert.equal(r.run.truncated, true);
    assert.ok(r.run.stdout.length <= 64 * 1024);
  });
});

test('la misma IP: la ejecución nueva sustituye a la antigua', { skip: !hasJdk && 'sin JDK', timeout: 20_000 }, async () => {
  await withServer({}, async (base) => {
    const lenta = post(base, { code: 'public class Main { public static void main(String[] a) throws Exception { Thread.sleep(4000); System.out.println("vieja"); } }' }).then((r) => r.status);
    await new Promise((r) => setTimeout(r, 1500));
    const nueva = await (await post(base, { code: 'public class Main { public static void main(String[] a){ System.out.println("nueva"); } }' })).json();
    assert.equal(nueva.run.stdout, 'nueva\n');
    assert.equal(await lenta, 409);
  });
});
