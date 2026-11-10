import test from 'node:test';
import assert from 'node:assert/strict';
import { Party } from '../../src/party.js';
import { defaultState } from '../../src/store.js';

const DAY = 24 * 60 * 60 * 1000;

function setup() {
  const clock = { t: 1_000_000 };
  const state = defaultState();
  const party = new Party({ state, now: () => clock.t });
  party.startParty('Noche');
  const join = (name) => party.join({ pin: state.party.pin, name });
  const play = (trackId, by, playLikes, queueLikes) => {
    clock.t += 1000;
    party.pushHistory({ trackId, uri: `spotify:track:${trackId}`, name: 'Tema ' + trackId, artists: ['X'], image: 'http://img/' + trackId, addedBy: by ? { id: by.id, name: by.name } : null, playedAt: clock.t, playLikes, queueLikes });
  };
  return { clock, state, party, join, play };
}

test('despedida: null mientras la fiesta esta activa', () => {
  const { party, join } = setup();
  const l = join('Laura');
  assert.equal(party.farewellFor(l.token), null);
});

test('despedida: null sin fiesta y sin endedAt', () => {
  const state = defaultState();
  const party = new Party({ state });
  assert.equal(party.farewellFor('x'), null);
  state.party = { id: 'p', active: false, startedAt: 1 };
  assert.equal(party.farewellFor('x'), null);
});

test('despedida tras kickAll: cancion y DJ de la noche, y datos propios por token', () => {
  const { party, join, play, state } = setup();
  const l = join('Laura'); const m = join('Marc'); const p = join('Pau');
  play('a', l.guest, 3, 0);   // Laura: 3 likes
  play('b', m.guest, 1, 9);   // Marc: 1 like, 9 votos (mas total, menos likes)
  play('c', l.guest, 0, 2);   // Laura: +2 votos
  play('d', null, 0, 0);      // relleno
  party.stopParty({ kickAll: true });
  assert.deepEqual(state.guests, {});

  const fl = party.farewellFor(l.token);
  assert.equal(fl.name, 'Noche'); assert.equal(fl.songs, 4); assert.ok(fl.endedAt);
  assert.deepEqual(fl.songOfNight, { name: 'Tema a', artists: ['X'], image: 'http://img/a', addedBy: 'Laura', likes: 3, votes: 0 });
  assert.deepEqual(fl.dj, { name: 'Laura', likes: 3, votes: 2 });
  assert.deepEqual(fl.mine, { songs: 2, likes: 3, votes: 2, best: { name: 'Tema a', likes: 3, votes: 0 } });

  const fm = party.farewellFor(m.token);
  assert.deepEqual(fm.mine, { songs: 1, likes: 1, votes: 9, best: { name: 'Tema b', likes: 1, votes: 9 } });
  // Pau no puso nada
  assert.deepEqual(party.farewellFor(p.token).mine, { songs: 0, likes: 0, votes: 0, best: null });
  // token desconocido o ausente
  assert.equal(party.farewellFor('nope'), null);
  assert.equal(party.farewellFor(undefined), null);
});

test('despedida: best es null si sus canciones no tuvieron likes ni votos', () => {
  const { party, join, play } = setup();
  const l = join('Laura');
  play('a', l.guest, 0, 0);
  party.stopParty({ kickAll: true });
  const f = party.farewellFor(l.token);
  assert.deepEqual(f.mine, { songs: 1, likes: 0, votes: 0, best: null });
  assert.equal(f.songOfNight, null); assert.equal(f.dj, null);
});

test('despedida sin expulsar (kickAll: false) tambien funciona', () => {
  const { party, join, play } = setup();
  const l = join('Laura');
  play('a', l.guest, 1, 1);
  party.stopParty({ kickAll: false });
  assert.equal(party.farewellFor(l.token).mine.songs, 1);
});

test('despedida: caduca a las 24 h', () => {
  const { party, join, play, clock } = setup();
  const l = join('Laura');
  play('a', l.guest, 1, 0);
  party.stopParty({ kickAll: true });
  clock.t += DAY - 1000;
  assert.ok(party.farewellFor(l.token));
  clock.t += 2000;
  assert.equal(party.farewellFor(l.token), null);
});

test('despedida: no filtra ids, PIN ni tokens; una fiesta nueva la borra', () => {
  const { party, join, play, state } = setup();
  const l = join('Laura'); const m = join('Marc');
  play('a', l.guest, 2, 1); play('b', m.guest, 1, 0);
  const pin = state.party.pin;
  party.stopParty({ kickAll: true });
  const json = JSON.stringify(party.farewellFor(l.token));
  for (const secret of [l.guest.id, m.guest.id, l.token, m.token, pin, 'tokens', 'farewell']) assert.ok(!json.includes(secret), 'filtra ' + secret);
  party.startParty('Otra');
  assert.equal(state.party.farewell, undefined);
  assert.equal(party.farewellFor(l.token), null);
});
