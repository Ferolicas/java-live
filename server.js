'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { validate } = require('./lib/source');
const { createRateLimiter, createGate } = require('./lib/limits');
const { createRunner, defaultJobsDir } = require('./lib/runner');

const PUBLIC_DIR = path.join(__dirname, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json',
};
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

function createServer(opts = {}) {
  const mode = opts.mode || process.env.RUNNER || 'sandbox';
  const runner = opts.runner || createRunner({
    mode,
    jobsDir: opts.jobsDir || process.env.JOBS_DIR || defaultJobsDir(mode),
    javaHome: opts.javaHome || process.env.JAVA_HOME_DIRECT || '',
  });
  const limiter = createRateLimiter({ burst: opts.burst ?? 20, perSecond: opts.perSecond ?? 0.7 });
  const gate = createGate({ maxConcurrent: opts.maxConcurrent ?? 3, maxQueue: opts.maxQueue ?? 8, maxWaitMs: 20_000 });
  const inflight = new Map(); // ip -> AbortController (la petición más reciente gana)

  const send = (res, status, body, headers = {}) => {
    const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Content-Type': isJson ? 'application/json; charset=utf-8' : (headers['Content-Type'] || 'text/plain; charset=utf-8'),
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(isJson ? JSON.stringify(body) : body);
  };

  const clientIp = (req) => {
    const peer = req.socket.remoteAddress || '';
    const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
    return (loopback && req.headers['x-real-ip']) || peer;
  };

  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'No encontrado');
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'No encontrado');
      const ext = path.extname(file);
      const cache = rel.startsWith('vendor/') ? 'public, max-age=604800, immutable' : 'no-cache';
      send(res, 200, data, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': cache });
    });
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { if (size - c.length <= limit) reject(Object.assign(new Error('grande'), { status: 413 })); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function handleRun(req, res) {
    const ip = clientIp(req);
    if (!(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'Se esperaba JSON' });
    if (!limiter.take(ip)) return send(res, 429, { error: 'Demasiadas ejecuciones seguidas. Espera unos segundos.' }, { 'Retry-After': '5' });

    let body;
    try { body = JSON.parse(await readBody(req, 80_000)); }
    catch (e) { return send(res, e.status || 400, { error: e.status === 413 ? 'Petición demasiado grande' : 'JSON no válido' }, e.status === 413 ? { Connection: 'close' } : {}); }
    const problem = validate(body);
    if (problem) return send(res, 400, { error: problem });

    // la ejecución nueva de la misma IP sustituye a la anterior; se cancela si el navegador se desconecta
    inflight.get(ip)?.abort();
    const ac = new AbortController();
    inflight.set(ip, ac);
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });

    const cancelled = () => { if (!res.writableEnded && !res.destroyed) send(res, 409, { error: 'Ejecución cancelada por una más reciente', cancelled: true }); };
    const release = await gate.acquire(ac.signal);
    try {
      if (ac.signal.aborted) return cancelled();
      if (!release) return send(res, 503, { error: 'Servidor ocupado, inténtalo de nuevo en un momento.' }, { 'Retry-After': '3' });
      const result = await runner.run({ code: body.code, stdin: body.stdin || '', signal: ac.signal });
      if (result.aborted || ac.signal.aborted) return cancelled();
      send(res, 200, result);
    } catch (e) {
      console.error(JSON.stringify({ level: 'error', msg: 'fallo al ejecutar', err: String(e && e.message) }));
      if (!res.headersSent) send(res, 500, { error: 'Error interno al ejecutar' });
    } finally {
      release?.();
      if (inflight.get(ip) === ac) inflight.delete(ip);
    }
  }

  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    if (req.method === 'GET' && pathname === '/api/health') {
      return runner.ready() ? send(res, 200, { ok: true, runner: runner.mode, ...gate.stats() }) : send(res, 503, { ok: false });
    }
    if (pathname === '/api/run') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Método no permitido' }, { Allow: 'POST' });
      return handleRun(req, res);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Método no permitido');
    return serveStatic(req, res, pathname);
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;

  const timers = [
    setInterval(() => limiter.sweep(), 5 * 60_000),
    setInterval(() => runner.sweep(), 60_000),
  ];
  timers.forEach((t) => t.unref());
  server.on('close', () => timers.forEach(clearInterval));
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 4012;
  const host = process.env.HOST || '127.0.0.1';
  const server = createServer();
  server.listen(port, host, () => console.log(JSON.stringify({ level: 'info', msg: 'java-live escuchando', host, port, runner: process.env.RUNNER || 'sandbox' })));
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { createServer };
