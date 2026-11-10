import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Library, summarize, selectForPlaylist, scoreOf } from '../../src/library.js';

const H = [
  { trackId: 'a', uri: 'spotify:track:a', name: 'A', artists: ['x'], addedBy: { id: 'g1', name: 'Laura' }, playedAt: 100, addedAt: 50, queueLikes: 2, playLikes: 3 },
  { trackId: 'b', uri: 'spotify:track:b', name: 'B', artists: ['y'], addedBy: null, filler: 'host', playedAt: 200, queueLikes: 0, playLikes: 1 },
  { trackId: 'c', uri: 'spotify:track:c', name: 'C', artists: ['z'], addedBy: { id: 'g2', name: 'Pau' }, playedAt: 300, addedAt: 20, queueLikes: 4, playLikes: 0 },
  { trackId: 'd', uri: 'spotify:track:d', name: 'D', artists: ['z'], addedBy: { id: 'g2', name: 'Pau' }, playedAt: 400, addedAt: 390, queueLikes: 0, playLikes: 0 },
];

test('resumen: cancion de la noche y DJ de la noche', () => {
  const s = summarize(H, { name: 'F', joined: 5 });
  assert.equal(s.songs, 4); assert.equal(s.likes, 10); assert.equal(s.queueLikes, 6); assert.equal(s.playLikes, 4);
  assert.equal(s.songOfNight.trackId, 'a');
  assert.deepEqual(s.bestDj, { name: 'Laura', likes: 3, votes: 2, songs: 1 });
  assert.equal(s.songOfNight.playLikes, 3); assert.equal(s.songOfNight.queueLikes, 2); assert.equal(s.songOfNight.likes, 5);
  assert.equal(s.joined, 5);
  assert.ok(!('mostActive' in s), 'sin mostActive');
  assert.ok(!('id' in s.bestDj), 'bestDj sin id');
});

const mk = (id, playLikes, queueLikes, playedAt, who) => ({ trackId: id, name: id, artists: [], addedBy: who || null, playedAt, playLikes, queueLikes });

test('resumen: cancion de la noche por likes y desempate por votos', () => {
  // c tiene mas total (5) pero b tiene mas likes sonando
  const s = summarize([mk('c', 1, 4, 100), mk('b', 2, 0, 200), mk('a', 0, 9, 50)]);
  assert.equal(s.songOfNight.trackId, 'b');
  assert.deepEqual(s.top.map((t) => t.trackId), ['b', 'c', 'a']);
  // mismos likes: gana la de mas votos; todo igual: la que sono antes
  assert.equal(summarize([mk('x', 2, 1, 100), mk('y', 2, 3, 200)]).songOfNight.trackId, 'y');
  assert.equal(summarize([mk('x', 2, 1, 300), mk('y', 2, 1, 200)]).songOfNight.trackId, 'y');
  assert.equal(summarize([mk('x', 0, 0, 100)]).songOfNight, null);
});

test('resumen: DJ de la noche por likes y desempate por votos', () => {
  const L = { id: 'g1', name: 'Laura' }; const P = { id: 'g2', name: 'Pau' }; const M = { id: 'g3', name: 'Mar' };
  // Pau tiene mas total (6) pero Laura mas likes (3 vs 1)
  let s = summarize([mk('a', 3, 0, 1, L), mk('b', 1, 5, 2, P)]);
  assert.deepEqual(s.bestDj, { name: 'Laura', likes: 3, votes: 0, songs: 1 });
  // mismos likes: mas votos
  s = summarize([mk('a', 2, 1, 1, L), mk('b', 1, 1, 2, P), mk('c', 1, 3, 3, P)]);
  assert.deepEqual(s.bestDj, { name: 'Pau', likes: 2, votes: 4, songs: 2 });
  // solo votos tambien cuenta; sin nada, nadie
  assert.equal(summarize([mk('a', 0, 2, 1, M)]).bestDj.votes, 2);
  assert.equal(summarize([mk('a', 0, 0, 1, M)]).bestDj, null);
});

test('playlist: filtros, tipo de like y orden', () => {
  assert.deepEqual(selectForPlaylist(H, {}).map((h) => h.trackId), ['a', 'b', 'c', 'd']);
  assert.deepEqual(selectForPlaylist(H, { order: 'played_desc' }).map((h) => h.trackId), ['d', 'c', 'b', 'a']);
  assert.deepEqual(selectForPlaylist(H, { order: 'likes_desc' }).map((h) => h.trackId), ['a', 'c', 'b', 'd']);
  assert.deepEqual(selectForPlaylist(H, { order: 'likes_desc', likeType: 'play' }).map((h) => h.trackId), ['a', 'b', 'c', 'd']);
  assert.deepEqual(selectForPlaylist(H, { minLikes: 1, likeType: 'queue' }).map((h) => h.trackId), ['a', 'c']);
  assert.deepEqual(selectForPlaylist(H, { includeFiller: false }).map((h) => h.trackId), ['a', 'c', 'd']);
  assert.deepEqual(selectForPlaylist(H, { order: 'added_asc' }).map((h) => h.trackId), ['c', 'a', 'b', 'd']);
  // repeticiones: se suman likes y sale una vez
  const rep = [...H, { ...H[3], playedAt: 500, playLikes: 2 }];
  const r = selectForPlaylist(rep, { minLikes: 2, likeType: 'play' });
  assert.deepEqual(r.map((h) => h.trackId), ['a', 'd']);
});

test('biblioteca: clasicos, excluir, relleno y archivo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-'));
  const lib = new Library(dir, { debounceMs: 1 }).load();
  for (const h of H) lib.recordPlay(h);
  lib.recordPlay({ ...H[2], playLikes: 1, queueLikes: 0, playedAt: 900 });
  assert.equal(scoreOf(lib.data.tracks.c), 3);
  assert.deepEqual(lib.classics({ minScore: 2 }).map((t) => t.trackId), ['a', 'c']);
  lib.setExcluded('c', true);
  assert.deepEqual(lib.classics({ minScore: 2 }).map((t) => t.trackId), ['a']);
  assert.equal(lib.pickFiller({ minScore: 2, exclude: new Set(['a']) }), null);
  assert.equal(lib.pickFiller({ minScore: 1, exclude: new Set(['b']) }).trackId, 'a');
  assert.ok(['a', 'b'].includes(lib.pickFiller({ minScore: 1 }).trackId));
  lib.archiveParty({ id: 'p1', name: 'F', startedAt: 0, endedAt: 1000, joined: 3 }, H.map((h) => ({ ...h, partyId: 'p1' })));
  lib.flush();
  const again = new Library(dir).load();
  assert.equal(again.listParties()[0].songs, 4);
  assert.equal(again.data.tracks.c.excluded, true);
});
