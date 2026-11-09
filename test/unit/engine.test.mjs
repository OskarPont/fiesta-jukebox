import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Party } from '../../src/party.js';
import { Store } from '../../src/store.js';
import { Spotify } from '../../src/spotify.js';
import { createMock } from '../../src/spotify-mock.js';
import { Engine } from '../../src/engine.js';

function setup() {
  const clock = { t: 5_000_000 };
  const now = () => clock.t;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fiesta-eng-'));
  const store = new Store(dir, { now }).load();
  const party = new Party({ state: store.state, now });
  const mock = createMock({ now });
  const sp = new Spotify({ store, config: { REDIRECT_URI: 'x', SCOPES: '' }, http: mock.http, now, sleep: async () => {}, mock: true });
  sp.mockConnect();
  const toasts = [];
  const engine = new Engine({ store, party, spotify: sp, now, autoTimers: false, toast: (t) => toasts.push(t) });
  party.startParty('t');
  store.state.settings.addCooldownSec = 0;
  store.state.settings.maxQueuedPerGuest = 20;
  const guest = party.join({ pin: store.state.party.pin, name: 'Laura' }).guest;
  const cat = mock.ctl.catalog;
  const add = (i) => { party.rememberTracks([{ uri: cat[i].uri, trackId: cat[i].id, name: cat[i].name, artists: [cat[i].artists[0].name], album: '', image: null, thumb: null, durationMs: cat[i].duration_ms, explicit: false }]); return party.addTrack(guest, cat[i].uri); };
  const adv = (ms) => { clock.t += ms; };
  return { clock, store, party, mock, sp, engine, add, adv, cat, toasts, s: store.state, dir };
}
const cleanup = (c) => fs.rmSync(c.dir, { recursive: true, force: true });

test('arranque en frio: reproduce la primera y la reconoce como propia', async () => {
  const c = setup();
  c.add(1);
  await c.engine.tick();
  assert.equal(c.mock.ctl.snapshot().current, c.cat[1].name);
  assert.ok(c.s.fed, 'fed tras el arranque');
  await c.engine.tick();
  assert.equal(c.s.fed, null);
  assert.equal(c.s.queue.length, 0);
  assert.equal(c.s.nowPlaying.fromQueue.addedBy.name, 'Laura');
  assert.ok(c.toasts.some((t) => t.includes('Ahora suena')));
  cleanup(c);
});

test('solo alimenta una cancion cada vez y en los ultimos 20 s', async () => {
  const c = setup();
  c.add(1); await c.engine.tick(); await c.engine.tick();       // suena la 1
  c.add(2); c.add(3);
  c.adv(30000); await c.engine.tick();
  assert.equal(c.s.fed, null, 'no alimenta con mucho tiempo por delante');
  const dur = c.cat[1].duration_ms;
  c.adv(dur - 30000 - 25000); await c.engine.tick();
  assert.equal(c.s.fed, null, 'a 25 s aun no');
  c.adv(6000); await c.engine.tick();
  assert.ok(c.s.fed, 'a 19 s si');
  assert.equal(c.s.fed.trackId, c.cat[2].id);
  assert.deepEqual(c.mock.ctl.snapshot().queue, [c.cat[2].name], 'solo una en la cola de Spotify');
  await c.engine.tick();
  assert.equal(c.mock.ctl.snapshot().queue.length, 1, 'no duplica');
  assert.equal(c.s.queue.find((q) => q.fed).trackId, c.cat[2].id);
  c.adv(20000); await c.engine.tick();
  assert.equal(c.mock.ctl.snapshot().current, c.cat[2].name);
  assert.equal(c.s.fed, null);
  assert.equal(c.s.history.length, 1);
  assert.equal(c.s.history[0].trackId, c.cat[1].id);
  cleanup(c);
});

test('los votos pueden reordenar hasta el ultimo momento', async () => {
  const c = setup();
  c.add(1); await c.engine.tick(); await c.engine.tick();
  const a = c.add(2); const b = c.add(3);
  c.adv(c.cat[1].duration_ms - 60000); await c.engine.tick();
  assert.equal(c.s.fed, null);
  const g2 = c.party.join({ pin: c.s.party.pin, name: 'Otro' }).guest;
  c.party.vote(g2, b.qid);
  c.adv(45000); await c.engine.tick();
  assert.equal(c.s.fed.trackId, c.cat[3].id, 'alimenta la mas votada');
  assert.ok(a);
  cleanup(c);
});

test('saltar sin fed: alimenta la primera y luego next', async () => {
  const c = setup();
  c.add(1); await c.engine.tick(); await c.engine.tick();
  c.add(2); c.add(3);
  await c.engine.skip();
  assert.equal(c.mock.ctl.snapshot().current, c.cat[2].name);
  await c.engine.tick();
  assert.equal(c.s.nowPlaying.fromQueue.addedBy.name, 'Laura');
  assert.equal(c.s.queue.length, 1);
  assert.equal(c.s.history.length, 1, 'la saltada entra en el historial aunque suene poco');
  cleanup(c);
});

test('saltar con fed: solo next', async () => {
  const c = setup();
  c.add(1); await c.engine.tick(); await c.engine.tick();
  c.add(2); c.add(3);
  c.adv(c.cat[1].duration_ms - 10000); await c.engine.tick();
  assert.equal(c.s.fed.trackId, c.cat[2].id);
  await c.engine.skip();
  assert.equal(c.mock.ctl.snapshot().current, c.cat[2].name);
  assert.equal(c.mock.ctl.snapshot().queue.length, 0, 'sin alimentar de mas');
  cleanup(c);
});

test('pausa: no se reanuda sola y no alimenta pausada', async () => {
  const c = setup();
  c.add(1); await c.engine.tick(); await c.engine.tick();
  await c.engine.pause();
  assert.equal(c.s.pausedByUs, true);
  c.add(2);
  c.adv(c.cat[1].duration_ms - 10000); await c.engine.tick();
  assert.equal(c.mock.ctl.snapshot().playing, false);
  assert.equal(c.s.fed, null, 'pausada no alimenta');
  await c.engine.resume();
  assert.equal(c.s.pausedByUs, false);
  assert.equal(c.mock.ctl.snapshot().playing, true);
  await c.engine.pause(); await c.engine.pause();   // pausar dos veces no rompe
  cleanup(c);
});

test('si Spotify pierde la cancion alimentada, se reintenta', async () => {
  const c = setup();
  c.add(1); await c.engine.tick(); await c.engine.tick();
  c.add(2);
  c.adv(c.cat[1].duration_ms - 10000); await c.engine.tick();
  assert.ok(c.s.fed);
  c.mock.ctl.state.queue = [];                        // Spotify limpia su cola
  c.mock.ctl.state.hasFiller = true; c.mock.ctl.state.filler = [c.cat[30]];
  c.adv(12000); await c.engine.tick();                 // empieza otra cancion que no es la nuestra
  c.adv(1000); await c.engine.tick();
  assert.equal(c.s.fed, null, 'fed descartada');
  assert.equal(c.s.queue.length, 1);
  c.adv(c.cat[30].duration_ms - 15000); await c.engine.tick();
  assert.ok(c.s.fed && c.s.fed.trackId === c.cat[2].id, 're-alimentada');
  cleanup(c);
});

test('429: entra en rate_limited sin lanzar y se recupera', async () => {
  const c = setup();
  c.add(1); await c.engine.tick(); await c.engine.tick();
  c.mock.ctl.rateLimit(10);
  await c.engine.tick();
  assert.equal(c.s.player.status, 'rate_limited');
  await c.engine.tick();                               // no vuelve a llamar mientras dura
  const calls = c.mock.ctl.state.calls.length;
  await c.engine.tick();
  assert.equal(c.mock.ctl.state.calls.length, calls);
  await assert.rejects(() => c.engine.skip(), (e) => e.kind === 'rate_limited');
  c.adv(11000); await c.engine.tick();
  assert.equal(c.s.player.status, 'ok');
  cleanup(c);
});

test('sin dispositivo: estado no_device y recuperacion', async () => {
  const c = setup();
  c.mock.ctl.disconnectDevice();
  c.add(1);
  await c.engine.tick();
  assert.equal(c.s.player.status, 'no_device');
  assert.equal(c.s.queue.length, 1);
  c.mock.ctl.connectDevice();
  c.adv(6000); await c.engine.tick();
  assert.equal(c.mock.ctl.snapshot().current, c.cat[1].name);
  assert.equal(c.s.player.status, 'ok');
  cleanup(c);
});

test('refresh token revocado: estado disconnected', async () => {
  const c = setup();
  c.mock.ctl.revokeRefresh(); c.mock.ctl.expireAccessToken();
  await c.engine.tick();
  assert.equal(c.s.player.status, 'disconnected');
  assert.equal(c.sp.connected, false);
  cleanup(c);
});

test('Spotify sin credenciales: not_configured', async () => {
  const c = setup();
  c.sp.mock = false;
  c.store.creds = null;
  await c.engine.tick();
  assert.equal(c.s.player.status, 'not_configured');
  cleanup(c);
});

test('cola vacia: sigue el relleno y no se toca el player', async () => {
  const c = setup();
  c.mock.ctl.startFiller(3);
  await c.engine.tick();
  assert.equal(c.s.nowPlaying.fromQueue, null);
  const calls = c.mock.ctl.state.calls.length;
  c.adv(5000); await c.engine.tick();
  assert.equal(c.mock.ctl.state.calls.filter((x) => !x.startsWith('GET')).length, 0);
  assert.ok(c.mock.ctl.state.calls.length > calls - 1);
  cleanup(c);
});
