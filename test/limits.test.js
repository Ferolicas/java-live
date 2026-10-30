'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter, createGate } = require('../lib/limits');

test('cubo de fichas: ráfaga, bloqueo y reposición', () => {
  let t = 0;
  const l = createRateLimiter({ burst: 3, perSecond: 1, now: () => t });
  assert.ok(l.take('a') && l.take('a') && l.take('a'));
  assert.equal(l.take('a'), false);
  assert.ok(l.take('b'), 'otra IP no se ve afectada');
  t += 1000;
  assert.ok(l.take('a'));
  assert.equal(l.take('a'), false);
});

test('semáforo: concurrencia, cola y rechazo cuando está lleno', async () => {
  const g = createGate({ maxConcurrent: 1, maxQueue: 1, maxWaitMs: 1000 });
  const r1 = await g.acquire();
  assert.equal(typeof r1, 'function');
  const p2 = g.acquire();
  assert.equal(await g.acquire(), null, 'cola llena');
  r1();
  const r2 = await p2;
  assert.equal(typeof r2, 'function');
  r2(); r2(); // liberar dos veces no debe romper el contador
  assert.deepEqual(g.stats(), { active: 0, queued: 0 });
});

test('semáforo: una espera cancelada sale de la cola', async () => {
  const g = createGate({ maxConcurrent: 1, maxQueue: 2, maxWaitMs: 1000 });
  const r1 = await g.acquire();
  const ac = new AbortController();
  const p = g.acquire(ac.signal);
  ac.abort();
  assert.equal(await p, null);
  assert.equal(g.stats().queued, 0);
  r1();
});
