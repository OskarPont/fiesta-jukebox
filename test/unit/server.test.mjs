import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, parseTrustProxy } from '../../src/config.js';
import { createApp } from '../../src/server.js';
import { makeAdminCookie } from '../../src/auth.js';

const SECRET = 'secreto-de-prueba-de-32-caracteres!!';

async function makeApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fiesta-srv-'));
  const cfg = { ...config, MOCK: true, DATA_DIR: dir, ADMIN_KEY: 'clave-de-prueba-123456', COOKIE_SECRET: SECRET, TRUST_PROXY: parseTrustProxy('') };
  const r = await createApp(cfg);
  const admin = `fiesta_admin=${makeAdminCookie(SECRET)}`;
  await r.app.inject({ method: 'POST', url: '/fiesta/api/admin/party/start', headers: { cookie: admin, 'content-type': 'application/json' }, payload: '{}' });
  return { ...r, admin, cleanup: async () => { await r.app.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const badJoin = (app, remoteAddress, xff) => app.inject({
  method: 'POST', url: '/fiesta/api/join', remoteAddress,
  headers: { 'content-type': 'application/json', ...(xff ? { 'x-forwarded-for': xff } : {}) },
  payload: JSON.stringify({ pin: 'xxxx', name: 'Intruso' }),
});

test('TRUST_PROXY: valores', () => {
  assert.equal(parseTrustProxy(''), 'loopback,linklocal,uniquelocal');
  assert.equal(parseTrustProxy('false'), false);
  assert.equal(parseTrustProxy('2'), 2);
  assert.equal(parseTrustProxy('10.0.0.1'), '10.0.0.1');
});

test('un cliente directo no puede falsear su IP con X-Forwarded-For para saltarse el límite de PIN', async () => {
  const { app, cleanup } = await makeApp();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await badJoin(app, '203.0.113.5', `198.51.100.${i}`)).statusCode, 403);
    const r = await badJoin(app, '203.0.113.5', '198.51.100.99');
    assert.equal(r.statusCode, 429, 'el sexto intento desde la misma IP real se bloquea');
  } finally { await cleanup(); }
});

test('detrás de un proxy privado se usa la IP real que añade el proxy, no la que inventa el cliente', async () => {
  const { app, cleanup } = await makeApp();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await badJoin(app, '172.18.0.2', `1.2.3.${i}, 203.0.113.9`)).statusCode, 403);
    assert.equal((await badJoin(app, '172.18.0.2', '9.9.9.9, 203.0.113.9')).statusCode, 429);
    assert.equal((await badJoin(app, '172.18.0.2', '203.0.113.10')).statusCode, 403, 'otro cliente real sigue pudiendo intentarlo');
  } finally { await cleanup(); }
});

async function firstState(base, cookie, query = '') {
  const ac = new AbortController();
  const res = await fetch(`${base}/fiesta/api/events${query}`, { headers: { cookie }, signal: ac.signal });
  const reader = res.body.getReader();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += Buffer.from(value).toString('utf8');
      const m = /event: state\ndata: (.+)\n\n/.exec(buf);
      if (m) return JSON.parse(m[1]);
    }
  } finally { ac.abort(); }
  throw new Error('sin estado');
}

test('el anfitrión puede usar la vista de invitado en el mismo navegador (?view=guest)', async () => {
  const { app, admin, store, cleanup } = await makeApp();
  try {
    const pin = store.state.party.pin;
    const j = await app.inject({ method: 'POST', url: '/fiesta/api/join', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ pin, name: 'Anfitrión' }) });
    assert.equal(j.statusCode, 200);
    const guest = j.cookies.find((c) => c.name === 'fiesta_guest');
    const both = `${admin}; fiesta_guest=${guest.value}`;
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    const asGuest = await firstState(base, both, '?view=guest');
    assert.equal(asGuest.me?.name, 'Anfitrión');
    assert.equal(asGuest.isAdmin, false);
    assert.equal(asGuest.admin, undefined, 'la vista de invitado no lleva datos de admin');
    const asAdmin = await firstState(base, both);
    assert.equal(asAdmin.isAdmin, true);
    const noGuest = await fetch(`${base}/fiesta/api/events?view=guest`, { headers: { cookie: admin } });
    assert.equal(noGuest.status, 401, 'con ?view=guest hace falta sesión de invitado');
  } finally { await cleanup(); }
});
