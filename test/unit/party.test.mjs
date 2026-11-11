import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Party, PartyError, validateSettings } from '../../src/party.js';
import { Store, defaultState, migrateSettings } from '../../src/store.js';

function mk() {
  const clock = { t: 1_000_000 };
  const state = defaultState();
  const party = new Party({ state, now: () => clock.t });
  party.startParty('Test');
  state.settings.addCooldownSec = 0;
  const join = (name) => party.join({ pin: state.party.pin, name }).guest;
  const tr = (i) => ({ uri: `spotify:track:track${String(i).padStart(18, '0')}`, trackId: `track${String(i).padStart(18, '0')}`, name: 'T' + i, artists: ['A'], album: 'x', image: null, thumb: null, durationMs: 180000, explicit: false });
  const learn = (...ids) => party.rememberTracks(ids.map(tr));
  return { clock, state, party, join, tr, learn };
}
const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof PartyError && e.code === code, `esperaba ${code}`);

test('ordenacion por votos con desempate por antiguedad', () => {
  const { party, join, learn, tr, clock } = mk();
  const a = join('A'); const b = join('B'); const c = join('C');
  learn(1, 2, 3);
  const i1 = party.addTrack(a, tr(1).uri); clock.t += 10;
  const i2 = party.addTrack(b, tr(2).uri); clock.t += 10;
  const i3 = party.addTrack(c, tr(3).uri);
  assert.deepEqual(party.orderedQueue().map((x) => x.name), ['T1', 'T2', 'T3']);
  party.vote(a, i3.qid); party.vote(b, i3.qid);
  assert.deepEqual(party.orderedQueue().map((x) => x.name), ['T3', 'T1', 'T2']);
  party.vote(c, i2.qid);
  assert.deepEqual(party.orderedQueue().map((x) => x.name), ['T3', 'T2', 'T1']);
});

test('justicia: 2a y 3a cancion del mismo invitado pierden 0,5 en el desempate', () => {
  const { party, join, learn, tr, clock } = mk();
  const a = join('A'); const b = join('B');
  learn(1, 2, 3);
  party.addTrack(a, tr(1).uri); clock.t += 10;
  party.addTrack(a, tr(2).uri); clock.t += 10;
  party.addTrack(b, tr(3).uri);
  assert.deepEqual(party.orderedQueue().map((x) => x.name), ['T1', 'T3', 'T2']);
  const i2 = party.findItem(party.orderedQueue()[2].qid);
  party.vote(b, i2.qid);   // T2 con 1 voto (0,5 efectivo) supera a T1 y T3 con 0
  assert.deepEqual(party.orderedQueue().map((x) => x.name), ['T2', 'T1', 'T3']);
});

test('fifo ignora votos y la cancion fed va siempre primera', () => {
  const { party, join, learn, tr, clock, state } = mk();
  const a = join('A'); const b = join('B');
  learn(1, 2, 3);
  const i1 = party.addTrack(a, tr(1).uri); clock.t += 10;
  const i2 = party.addTrack(b, tr(2).uri); clock.t += 10;
  const i3 = party.addTrack(a, tr(3).uri);
  party.vote(b, i3.qid);
  assert.equal(party.orderedQueue()[0].name, 'T3');   // 1 voto - 0,5 = 0,5 > 0
  state.settings.ordering = 'fifo';
  assert.deepEqual(party.orderedQueue().map((x) => x.name), ['T1', 'T2', 'T3']);
  i3.fed = true;
  assert.equal(party.orderedQueue()[0].name, 'T3');
  throwsCode(() => party.vote(b, i3.qid), 'fed');
  throwsCode(() => party.removeTrack(i3.qid, a), 'fed');
  assert.ok(i1 && i2);
});

test('orden manual del admin manda sobre los votos', () => {
  const { party, join, learn, tr, clock } = mk();
  const a = join('A'); const b = join('B');
  learn(1, 2, 3);
  const i1 = party.addTrack(a, tr(1).uri); clock.t += 10;
  const i2 = party.addTrack(b, tr(2).uri); clock.t += 10;
  const i3 = party.addTrack(b, tr(3).uri);
  party.vote(a, i3.qid);
  party.adminReorder([i2.qid, i1.qid, i3.qid]);
  assert.deepEqual(party.orderedQueue().map((x) => x.name), ['T2', 'T1', 'T3']);
  party.adminTop(i3.qid);
  assert.equal(party.orderedQueue()[0].name, 'T3');
});

test('limite por invitado, cooldown, duplicados y votos propios', () => {
  const { party, join, learn, tr, clock, state } = mk();
  state.settings.maxQueuedPerGuest = 2; state.settings.addCooldownSec = 15;
  const a = join('A'); const b = join('B');
  learn(1, 2, 3, 4);
  const i1 = party.addTrack(a, tr(1).uri);
  throwsCode(() => party.addTrack(a, tr(2).uri), 'cooldown');
  clock.t += 15000;
  party.addTrack(a, tr(2).uri); clock.t += 15000;
  throwsCode(() => party.addTrack(a, tr(3).uri), 'limit');
  throwsCode(() => party.addTrack(b, tr(1).uri), 'duplicate');
  throwsCode(() => party.vote(a, i1.qid), 'own_song');
  party.vote(b, i1.qid); party.vote(b, i1.qid);
  assert.equal(i1.votes.length, 1, 'un voto por invitado');
  party.vote(b, i1.qid, false);
  assert.equal(i1.votes.length, 0);
  throwsCode(() => party.removeTrack(i1.qid, b), 'forbidden');
  party.removeTrack(i1.qid, a);
  assert.equal(party.quotaLeft(a), 1);
});

test('solo se aceptan canciones devueltas por una busqueda', () => {
  const { party, join, tr } = mk();
  const a = join('A');
  throwsCode(() => party.addTrack(a, tr(9).uri), 'unknown_track');
  throwsCode(() => party.addTrack(a, 'spotify:track:../../x'), 'unknown_track');
});

test('noRepeat, cancion sonando, explicitas y duracion', () => {
  const { party, join, learn, tr, clock, state } = mk();
  const a = join('A');
  state.settings.noRepeatMin = 60;
  learn(1, 2);
  party.pushHistory({ trackId: tr(1).trackId, uri: tr(1).uri, name: 'T1', artists: [], playedAt: clock.t - 10 * 60000 });
  throwsCode(() => party.addTrack(a, tr(1).uri), 'recent');
  clock.t += 45 * 60000;
  throwsCode(() => party.addTrack(a, tr(1).uri), 'recent');
  clock.t += 6 * 60000;
  party.addTrack(a, tr(1).uri);
  state.nowPlaying = { trackId: tr(2).trackId };
  state.settings.noRepeatMin = 0;
  throwsCode(() => party.addTrack(a, tr(2).uri), 'recent');
  const ex = { ...tr(3), explicit: true }; const long = { ...tr(4), durationMs: 11 * 60000 };
  party.rememberTracks([ex, long]);
  state.settings.allowExplicit = false;
  throwsCode(() => party.addTrack(a, ex.uri), 'explicit');
  throwsCode(() => party.addTrack(a, long.uri), 'too_long');
  state.settings.allowAdd = false;
  throwsCode(() => party.addTrack(a, tr(1).uri), 'closed');
});

test('umbral de votos de salto por porcentaje', () => {
  const { party, join, state } = mk();
  state.nowPlaying = { trackId: 'x', skipVotes: [] };
  state.settings.skipVoteMode = 'pct'; state.settings.skipVotePct = 50;
  const gs = [];
  const expected = new Map([[0, 1], [1, 1], [3, 2], [10, 5]]);
  for (let n = 0; n <= 10; n++) {
    if (expected.has(n)) assert.equal(party.skipNeeded(), expected.get(n), `${n} activos al 50 %`);
    if (n < 10) gs.push(join('G' + n));
  }
  party.skipVote(gs[0]); const r = party.skipVote(gs[1]);
  assert.deepEqual([r.votes, r.needed, r.reached], [2, 5, false]);
  party.skipVote(gs[0], false); assert.equal(party.currentSkipVotes().length, 1);
  party.skipVote(gs[0]);   // idempotente
  party.skipVote(gs[0]);
  assert.equal(party.currentSkipVotes().length, 2);
});

test('umbral de votos de salto con numero fijo: nunca imposible', () => {
  const { party, join, state } = mk();
  state.settings.skipVoteMode = 'fixed';
  state.settings.skipVoteFixed = 20;
  assert.equal(party.skipNeeded(), 1);   // 0 activos
  for (const n of ['A', 'B', 'C']) join(n);
  assert.equal(party.skipNeeded(), 3);   // 20 pero solo hay 3
  state.settings.skipVoteFixed = 2;
  for (let i = 0; i < 7; i++) join('Z' + i);
  assert.equal(party.skipNeeded(), 2);   // 10 activos
});

test('migracion de ajustes de votos de salto', () => {
  const m = (o) => { const st = { ...o }; const changed = migrateSettings(st); return [st, changed]; };
  assert.deepEqual(m({ skipVotePct: 40, skipVoteMin: 2 }), [{ skipVotePct: 40, skipVoteMode: 'pct' }, true]);
  assert.deepEqual(m({ skipVotePct: 43, skipVoteMin: 9 }), [{ skipVotePct: 43, skipVoteMode: 'fixed', skipVoteFixed: 9 }, true]);
  assert.deepEqual(m({ skipVotePct: 5, skipVoteMin: 1 }), [{ skipVotePct: 10, skipVoteMode: 'pct' }, true]);
  assert.deepEqual(m({ skipVotePct: 40, skipVoteMin: 30 })[0].skipVoteFixed, 20);
  const done = { skipVoteMode: 'fixed', skipVotePct: 60, skipVoteFixed: 4 };
  assert.deepEqual(m(done), [done, false]);
  // al cargar state.json: se migra, se aplican los valores por defecto y se persiste
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fiesta-mig-'));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ settings: { skipVotePct: 43, skipVoteMin: 9, ordering: 'fifo' } }));
  const store = new Store(dir, { debounceMs: 5 }).load();
  const st = store.state.settings;
  assert.equal(st.skipVoteMode, 'fixed'); assert.equal(st.skipVoteFixed, 9); assert.equal(st.ordering, 'fifo');
  assert.ok(!('skipVoteMin' in st));
  store.flush();
  assert.ok(!('skipVoteMin' in JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).settings));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('los invitados inactivos no cuentan para el umbral', () => {
  const { party, join, clock } = mk();
  join('A'); join('B'); join('C');
  assert.equal(party.activeCount(), 3);
  clock.t += 11 * 60000;
  assert.equal(party.activeCount(), 0);
  const g = Object.values(party.s.guests)[0];
  party.setConnected(g.id, 1);
  assert.equal(party.activeCount(), 1);
});

test('cooldown de control: por invitado y global', () => {
  const { party, join, clock, state } = mk();
  state.settings.controlCooldownSec = 20; state.settings.globalControlCooldownSec = 8;
  const a = join('A'); const b = join('B');
  party.checkDirectControl(a); party.markControl(a);
  throwsCode(() => party.checkDirectControl(b), 'cooldown');     // global
  clock.t += 9000;
  party.checkDirectControl(b);                                   // global libre
  throwsCode(() => party.checkDirectControl(a), 'cooldown');     // propio
  clock.t += 12000;
  party.checkDirectControl(a);
});

test('PIN, nombres, expulsion, baneo y bloqueo', () => {
  const { party, state, join } = mk();
  throwsCode(() => party.join({ pin: '0000' === state.party.pin ? '1111' : '0000', name: 'X' }), 'bad_pin');
  throwsCode(() => party.join({ pin: state.party.pin, name: '   ' }), 'bad_name');
  const a = party.join({ pin: state.party.pin, name: '  Ana   López  ' });
  assert.equal(a.guest.name, 'Ana López');
  const b = party.join({ pin: state.party.pin, name: 'ana lópez' });
  assert.equal(b.guest.name, 'ana lópez 2');
  assert.equal(party.join({ pin: state.party.pin, name: 'x'.repeat(50) }).guest.name.length, 24);
  // sesion existente: cambia nombre sin PIN
  const r = party.join({ pin: '', name: 'Nuevo', token: a.token });
  assert.equal(r.created, false); assert.equal(r.guest.name, 'Nuevo');
  party.ban(b.guest.id);
  assert.equal(party.getGuest(b.token), null);
  throwsCode(() => party.join({ pin: state.party.pin, name: 'Otro', token: b.token }), 'banned');
  party.kick(a.guest.id);
  assert.equal(party.getGuest(a.token), null);
  const old = state.party.pin;
  const c = join('C');
  party.regenPin({ kickAll: false });
  assert.notEqual(state.party.pin, old);
  assert.ok(party.getGuest(Object.keys(state.guests).find((t) => state.guests[t] === c)), 'mantiene');
  party.regenPin({ kickAll: true });
  assert.equal(party.getGuest(Object.keys(state.guests).find((t) => state.guests[t] === c)), null);
  for (let i = 0; i < 20; i++) { try { party.join({ pin: '0000' === state.party.pin ? '1111' : '0000', name: 'X' }); } catch { /* */ } }
  throwsCode(() => party.join({ pin: state.party.pin, name: 'Z' }), 'join_blocked');
});

test('terminar la fiesta invalida invitados', () => {
  const { party, join, state } = mk();
  const a = join('A');
  const token = Object.keys(state.guests)[0];
  party.stopParty({ kickAll: true });
  assert.equal(party.getGuest(token), null);
  assert.ok(a);
  throwsCode(() => party.join({ pin: '1234', name: 'x' }), 'no_party');
});

test('validacion de ajustes', () => {
  assert.deepEqual(validateSettings({ skipVotePct: 50, ordering: 'fifo', allowAdd: false }), { skipVotePct: 50, ordering: 'fifo', allowAdd: false });
  for (const bad of [{ skipVotePct: 0 }, { skipVotePct: 5 }, { skipVoteFixed: 25 }, { skipVoteFixed: 0 }, { skipVoteMode: 'x' }, { skipVoteMin: 2 }, { skipVotePct: 101 }, { skipVotePct: 1.5 }, { skipVotePct: '5' }, { ordering: 'x' }, { allowAdd: 'si' }, { nope: 1 }, { maxDurationMin: 0 }, { noRepeatMin: -1 }, null, []]) {
    assert.throws(() => validateSettings(bad), PartyError, JSON.stringify(bad));
  }
});

test('persistencia atomica y recuperacion de JSON corrupto', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fiesta-unit-'));
  const s1 = new Store(dir, { debounceMs: 5 }).load();
  s1.state.settings.maxQueuedPerGuest = 9; s1.state.history.push({ trackId: 'a' });
  s1.flush();
  assert.ok(!fs.readdirSync(dir).some((f) => f.includes('.tmp-')), 'sin tmp');
  const s2 = new Store(dir).load();
  assert.equal(s2.state.settings.maxQueuedPerGuest, 9);
  assert.equal(s2.state.history.length, 1);
  fs.writeFileSync(path.join(dir, 'state.json'), '{"settings": {corrupto');
  fs.writeFileSync(path.join(dir, 'spotify.json'), 'nope');
  const s3 = new Store(dir).load();
  assert.equal(s3.state.settings.maxQueuedPerGuest, 3);
  assert.equal(s3.tokens, null);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('state.json.corrupt-')));
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('spotify.json.corrupt-')));
  s3.saveTokens({ refreshToken: 'x' });
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'spotify.json')).mode & 0o777, 0o600); // Windows no tiene permisos POSIX
  fs.rmSync(dir, { recursive: true, force: true });
});

test('deshacer baja del anfitrion: vuelve al mismo puesto (votos y manual)', () => {
  const { party, join, learn, tr, clock } = mk();
  const a = join('A'); const b = join('B'); const c = join('C');
  learn(1, 2, 3, 4);
  const i1 = party.addTrack(a, tr(1).uri); clock.t += 10;
  const i2 = party.addTrack(b, tr(2).uri); clock.t += 10;
  const i3 = party.addTrack(c, tr(3).uri); clock.t += 10;
  party.vote(a, i3.qid); party.vote(b, i3.qid);
  const before = party.orderedQueue().map((x) => x.name);
  assert.deepEqual(before, ['T3', 'T1', 'T2']);
  party.removeTrack(i3.qid, null);
  assert.deepEqual(party.orderedQueue().map((x) => x.name), ['T1', 'T2']);
  const back = party.restoreTrack(i3.qid);
  assert.equal(back, i3);
  assert.equal(back.votes.length, 2);
  assert.deepEqual(party.orderedQueue().map((x) => x.name), before);
  // con manual
  party.adminReorder([i2.qid, i1.qid, i3.qid]);
  const manual = party.orderedQueue().map((x) => x.name);
  assert.deepEqual(manual, ['T2', 'T1', 'T3']);
  party.removeTrack(i1.qid, null);
  party.restoreTrack(i1.qid);
  assert.deepEqual(party.orderedQueue().map((x) => x.name), manual);
  assert.equal(party.lastRemoved, null);
});

test('deshacer baja: falla a los 30 s, sin baja previa, con otro qid o si ya esta en la cola', () => {
  const { party, join, learn, tr, clock } = mk();
  const a = join('A');
  learn(1, 2);
  const i1 = party.addTrack(a, tr(1).uri); clock.t += 10;
  const i2 = party.addTrack(a, tr(2).uri);
  throwsCode(() => party.restoreTrack(i1.qid), 'cant_restore');
  party.removeTrack(i1.qid, null);
  throwsCode(() => party.restoreTrack(i2.qid), 'cant_restore');
  clock.t += 30_001;
  throwsCode(() => party.restoreTrack(i1.qid), 'cant_restore');
  party.removeTrack(i2.qid, null);
  clock.t += 30_000;
  party.restoreTrack(i2.qid); // justo en el limite aun vale
  throwsCode(() => party.restoreTrack(i2.qid), 'cant_restore');
  // ya en la cola: duplicado de qid
  party.removeTrack(i2.qid, null);
  party.s.queue.push({ ...i2 });
  throwsCode(() => party.restoreTrack(i2.qid), 'cant_restore');
});

test('la baja de un invitado no se puede deshacer', () => {
  const { party, join, learn, tr } = mk();
  const a = join('A');
  learn(1);
  const i1 = party.addTrack(a, tr(1).uri);
  party.removeTrack(i1.qid, a);
  assert.equal(party.lastRemoved, null);
  throwsCode(() => party.restoreTrack(i1.qid), 'cant_restore');
});
