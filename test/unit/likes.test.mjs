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

test('resumen: cancion de la noche, mejor DJ y mas activo', () => {
  const s = summarize(H, { name: 'F', joined: 5 });
  assert.equal(s.songs, 4); assert.equal(s.likes, 10); assert.equal(s.queueLikes, 6); assert.equal(s.playLikes, 4);
  assert.equal(s.songOfNight.trackId, 'a');
  assert.equal(s.bestDj.name, 'Laura'); assert.equal(s.bestDj.likes, 5);
  assert.equal(s.mostActive.name, 'Pau'); assert.equal(s.mostActive.songs, 2);
  assert.equal(s.joined, 5);
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
