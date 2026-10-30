'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { analyze } = require('./source');

const HELPER = '/usr/local/sbin/java-live-run';
const OUT_CAP = 64 * 1024;
const COMPILE_ERR_CAP = 20 * 1024;

function createRunner({ mode, jobsDir, javaHome }) {
  const sandbox = mode === 'sandbox';
  const bin = (name) => (javaHome ? path.join(javaHome, 'bin', name) : name);

  function helper(phase, id, ...rest) {
    return spawn('sudo', ['-n', HELPER, phase, id, ...rest], { stdio: ['pipe', 'pipe', 'pipe'] });
  }

  // Ejecuta un proceso con tope de salida y de tiempo. Devuelve { code, stdout, stderr, truncated, timedOut, aborted }.
  function exec(child, { stdin, cap, timeoutMs, signal, onKill }) {
    return new Promise((resolve) => {
      const res = { code: null, stdout: '', stderr: '', truncated: false, timedOut: false, aborted: false };
      const bufs = { stdout: [], stderr: [] };
      const sizes = { stdout: 0, stderr: 0 };
      let killed = false;
      const kill = () => { if (killed) return; killed = true; onKill?.(); try { child.kill('SIGKILL'); } catch { /* ya terminó */ } };

      const timer = setTimeout(() => { res.timedOut = true; kill(); }, timeoutMs);
      const onAbort = () => { res.aborted = true; kill(); };
      if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });

      for (const k of ['stdout', 'stderr']) {
        child[k].on('data', (d) => {
          if (sizes[k] >= cap) { res.truncated = true; kill(); return; }
          bufs[k].push(d); sizes[k] += d.length;
          if (sizes[k] > cap) { res.truncated = true; kill(); }
        });
      }
      child.stdin.on('error', () => {});
      child.stdin.end(stdin || '');

      child.on('close', (code, sig) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        res.code = code ?? (sig ? 137 : 1);
        for (const k of ['stdout', 'stderr']) res[k] = Buffer.concat(bufs[k]).subarray(0, cap).toString('utf8');
        resolve(res);
      });
      child.on('error', () => { clearTimeout(timer); res.code = 127; resolve(res); });
    });
  }

  async function run({ code, stdin, signal }) {
    const info = analyze(code);
    const id = crypto.randomBytes(16).toString('hex');
    const dir = path.join(jobsDir, id);
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o777);
    fs.writeFileSync(path.join(dir, info.fileName), code, { mode: 0o644 });

    const stop = () => { if (sandbox) spawn('sudo', ['-n', HELPER, 'stop', id], { stdio: 'ignore' }).on('error', () => {}); };
    const out = { fileName: info.fileName, mainClass: info.mainClass };
    try {
      // compilar
      let t = Date.now();
      const cChild = sandbox
        ? helper('compile', id, info.fileName)
        : spawn(bin('javac'), ['-encoding', 'UTF-8', '-proc:none', '-Xmaxerrs', '20', '-d', '.', info.fileName], { cwd: dir });
      const c = await exec(cChild, { cap: COMPILE_ERR_CAP, timeoutMs: 21_000, signal, onKill: stop });
      out.compile = { ok: c.code === 0, output: (c.stderr + c.stdout).trim(), ms: Date.now() - t, timedOut: c.timedOut || c.code === 124 };
      if (c.aborted) { out.aborted = true; return out; }
      if (!out.compile.ok) return out;

      // ejecutar
      t = Date.now();
      const rChild = sandbox
        ? helper('run', id, info.mainClass)
        : spawn(bin('java'), ['-Xmx128m', '-Xss1m', '-XX:+UseSerialGC', '-cp', '.', info.mainClass], { cwd: dir });
      const r = await exec(rChild, { stdin, cap: OUT_CAP, timeoutMs: sandbox ? 9_000 : 5_000, signal, onKill: stop });
      out.run = {
        code: r.code, stdout: r.stdout, stderr: r.stderr, truncated: r.truncated,
        timedOut: r.timedOut || r.code === 124, ms: Date.now() - t,
      };
      if (r.aborted) out.aborted = true;
      return out;
    } finally {
      if (sandbox) {
        spawn('sudo', ['-n', HELPER, 'clean', id], { stdio: 'ignore' }).on('error', () => {});
      } else {
        fs.rm(dir, { recursive: true, force: true }, () => {});
      }
    }
  }

  // Limpia trabajos huérfanos (p. ej. tras un reinicio brusco).
  function sweep(maxAgeMs = 2 * 60_000) {
    let names = [];
    try { names = fs.readdirSync(jobsDir); } catch { return; }
    for (const n of names) {
      if (!/^[0-9a-f]{32}$/.test(n)) continue;
      try {
        if (Date.now() - fs.statSync(path.join(jobsDir, n)).mtimeMs < maxAgeMs) continue;
        if (sandbox) spawn('sudo', ['-n', HELPER, 'clean', n], { stdio: 'ignore' }).on('error', () => {});
        else fs.rmSync(path.join(jobsDir, n), { recursive: true, force: true });
      } catch { /* ignorar */ }
    }
  }

  const ready = () => (sandbox ? fs.existsSync(HELPER) && fs.existsSync(jobsDir) : true);
  return { run, sweep, ready, mode };
}

function defaultJobsDir(mode) {
  return mode === 'sandbox' ? '/var/lib/java-live/jobs' : fs.mkdtempSync(path.join(os.tmpdir(), 'java-live-'));
}

module.exports = { createRunner, defaultJobsDir };
