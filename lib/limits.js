'use strict';

// Cubo de fichas por clave (IP): `burst` peticiones seguidas y `perSecond` de reposición.
function createRateLimiter({ burst, perSecond, now = () => Date.now() }) {
  const buckets = new Map();
  return {
    take(key) {
      const t = now();
      const b = buckets.get(key) || { tokens: burst, at: t };
      b.tokens = Math.min(burst, b.tokens + ((t - b.at) / 1000) * perSecond);
      b.at = t;
      buckets.set(key, b);
      if (b.tokens < 1) return false;
      b.tokens -= 1;
      return true;
    },
    sweep() {
      const t = now();
      for (const [k, b] of buckets) if (t - b.at > 10 * 60_000) buckets.delete(k);
    },
  };
}

// Semáforo con cola acotada. acquire() resuelve con una función release, o null si no hay sitio / se agota la espera.
function createGate({ maxConcurrent, maxQueue, maxWaitMs }) {
  let active = 0;
  const queue = [];
  const release = () => {
    active--;
    const next = queue.shift();
    if (next) { active++; clearTimeout(next.timer); next.resolve(release1()); }
  };
  const release1 = () => { let done = false; return () => { if (!done) { done = true; release(); } }; };
  return {
    acquire(signal) {
      if (signal?.aborted) return Promise.resolve(null);
      if (active < maxConcurrent) { active++; return Promise.resolve(release1()); }
      if (queue.length >= maxQueue) return Promise.resolve(null);
      return new Promise((resolve) => {
        const entry = { resolve };
        const drop = () => { const i = queue.indexOf(entry); if (i >= 0) queue.splice(i, 1); clearTimeout(entry.timer); resolve(null); };
        entry.timer = setTimeout(drop, maxWaitMs);
        signal?.addEventListener('abort', drop, { once: true });
        queue.push(entry);
      });
    },
    stats: () => ({ active, queued: queue.length }),
  };
}

module.exports = { createRateLimiter, createGate };
