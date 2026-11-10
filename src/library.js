import fs from 'node:fs';
import path from 'node:path';
import { readJsonSafe, writeJsonAtomic } from './store.js';

const PARTIES_MAX = 40;

/** Puntos de una cancion: like sonando = 1, like en cola = 0,5. */
export const scoreOf = (t) => (t.playLikes || 0) + 0.5 * (t.queueLikes || 0);
export const likesOf = (h, type = 'total') =>
  type === 'play' ? (h.playLikes || 0) : type === 'queue' ? (h.queueLikes || 0) : (h.playLikes || 0) + (h.queueLikes || 0);

/**
 * Biblioteca persistente entre fiestas (data/library.json):
 * - tracks: estadisticas acumuladas por cancion (solo lo que suena con fiesta activa)
 * - parties: fiestas archivadas con su historial
 * - classics: playlist "Clásicos de fiesta" en Spotify
 */
export class Library {
  constructor(dir, { now = Date.now, debounceMs = 1000 } = {}) {
    this.file = path.join(dir, 'library.json');
    this.now = now; this.debounceMs = debounceMs; this.timer = null;
    this.data = { tracks: {}, parties: [], classics: { playlistId: null, url: null, updatedAt: 0, count: 0 } };
    fs.mkdirSync(dir, { recursive: true });
  }

  load() {
    const d = readJsonSafe(this.file, this.now);
    if (d) {
      if (d.tracks && typeof d.tracks === 'object' && !Array.isArray(d.tracks)) this.data.tracks = d.tracks;
      if (Array.isArray(d.parties)) this.data.parties = d.parties;
      if (d.classics && typeof d.classics === 'object') this.data.classics = { ...this.data.classics, ...d.classics };
    }
    return this;
  }
  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.debounceMs);
    this.timer.unref?.();
  }
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try { writeJsonAtomic(this.file, this.data); } catch (e) { console.error('[library] no se pudo guardar', e.message); }
  }

  // ---------- canciones ----------
  recordPlay(e) {
    if (!e?.trackId) return;
    const t = this.data.tracks[e.trackId] || (this.data.tracks[e.trackId] = {
      trackId: e.trackId, plays: 0, queueLikes: 0, playLikes: 0, firstPlayedAt: e.playedAt, excluded: false,
    });
    Object.assign(t, { uri: e.uri, name: e.name, artists: e.artists, image: e.image, durationMs: e.durationMs || t.durationMs || 0 });
    t.plays += 1;
    t.queueLikes += e.queueLikes || 0;
    t.playLikes += e.playLikes || 0;
    t.lastPlayedAt = e.playedAt;
    this.save();
  }

  setExcluded(trackId, excluded) {
    const t = this.data.tracks[trackId];
    if (!t) return false;
    t.excluded = !!excluded; this.save();
    return true;
  }

  /** Clasicos: canciones con puntos >= minScore, mejores primero. */
  classics({ minScore = 2, limit = 100, includeExcluded = false } = {}) {
    return Object.values(this.data.tracks)
      .filter((t) => (includeExcluded || !t.excluded) && scoreOf(t) >= minScore && t.uri)
      .sort((a, b) => scoreOf(b) - scoreOf(a) || b.playLikes - a.playLikes || b.plays - a.plays || (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0))
      .slice(0, limit);
  }

  /** Elige un clasico para el relleno, al azar con peso por puntos, evitando los de `exclude`. */
  pickFiller({ minScore = 2, exclude = new Set(), random = Math.random } = {}) {
    const pool = this.classics({ minScore, limit: 60 }).filter((t) => !exclude.has(t.trackId));
    if (!pool.length) return null;
    const weights = pool.map((t) => Math.max(0.5, scoreOf(t)));
    let r = random() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < pool.length; i++) { r -= weights[i]; if (r <= 0) return pool[i]; }
    return pool[pool.length - 1];
  }

  // ---------- fiestas ----------
  archiveParty(party, history, extra = {}) {
    if (!party?.id) return;
    const entry = {
      id: party.id, name: party.name, startedAt: party.startedAt, endedAt: party.endedAt || this.now(),
      joined: party.joined || 0, ...extra,
      history: history.filter((h) => h.partyId === party.id || (!h.partyId && h.playedAt >= party.startedAt)).map((h) => ({ ...h })),
    };
    const i = this.data.parties.findIndex((p) => p.id === party.id);
    if (i >= 0) this.data.parties[i] = entry; else this.data.parties.unshift(entry);
    this.data.parties.sort((a, b) => b.startedAt - a.startedAt);
    if (this.data.parties.length > PARTIES_MAX) this.data.parties.length = PARTIES_MAX;
    this.save();
  }
  getParty(id) { return this.data.parties.find((p) => p.id === id) || null; }
  listParties() {
    return this.data.parties.map((p) => ({ id: p.id, name: p.name, startedAt: p.startedAt, endedAt: p.endedAt, songs: p.history.length }));
  }

  setClassicsPlaylist(info) { this.data.classics = { ...this.data.classics, ...info }; this.save(); }
}

// ---------- resumen y playlists (funciones puras) ----------

/** Resumen de una fiesta a partir de su historial. */
export function summarize(history, { name = null, startedAt = null, endedAt = null, joined = 0 } = {}) {
  const songs = history.length;
  let queueLikes = 0; let playLikes = 0;
  const djs = new Map();
  for (const h of history) {
    queueLikes += h.queueLikes || 0; playLikes += h.playLikes || 0;
    if (h.addedBy?.id) {
      const d = djs.get(h.addedBy.id) || { name: h.addedBy.name, songs: 0, likes: 0, votes: 0 };
      d.songs += 1; d.likes += h.playLikes || 0; d.votes += h.queueLikes || 0; d.name = h.addedBy.name;
      djs.set(h.addedBy.id, d);
    }
  }
  const pick = (h) => ({
    trackId: h.trackId, name: h.name, artists: h.artists, image: h.image,
    addedBy: h.addedBy?.name || null, queueLikes: h.queueLikes || 0, playLikes: h.playLikes || 0, likes: likesOf(h),
  });
  // like (sonando) pesa mas que voto (en cola); a igualdad, la que sono antes
  const ranked = [...history].filter((h) => likesOf(h) > 0)
    .sort((a, b) => (b.playLikes || 0) - (a.playLikes || 0) || (b.queueLikes || 0) - (a.queueLikes || 0) || a.playedAt - b.playedAt);
  const bestDj = [...djs.values()].filter((d) => d.likes + d.votes > 0)
    .sort((a, b) => b.likes - a.likes || b.votes - a.votes || b.songs - a.songs)
    .map(({ name, likes, votes, songs }) => ({ name, likes, votes, songs }))[0] || null;
  return {
    name, startedAt, endedAt, joined,
    songs, requested: history.filter((h) => h.addedBy).length,
    queueLikes, playLikes, likes: queueLikes + playLikes,
    songOfNight: ranked[0] ? pick(ranked[0]) : null,
    top: ranked.slice(0, 5).map(pick),
    bestDj,
  };
}

/**
 * Elige y ordena canciones para una playlist.
 * opts: { minLikes, likeType: total|play|queue, order: likes_desc|likes_asc|played_asc|played_desc|added_asc|added_desc, includeFiller }
 */
export function selectForPlaylist(history, opts = {}) {
  const likeType = ['total', 'play', 'queue'].includes(opts.likeType) ? opts.likeType : 'total';
  const minLikes = Math.max(0, Math.min(1000, Number(opts.minLikes) || 0));
  const includeFiller = opts.includeFiller !== false;
  // juntar repeticiones de la misma cancion (suma de likes, primera vez que sono / se pidio)
  const byId = new Map();
  for (const h of history) {
    if (!h.uri) continue;
    if (!includeFiller && !h.addedBy) continue;
    const cur = byId.get(h.trackId);
    if (!cur) byId.set(h.trackId, { ...h, queueLikes: h.queueLikes || 0, playLikes: h.playLikes || 0, addedAt: h.addedAt || h.playedAt });
    else {
      cur.queueLikes += h.queueLikes || 0; cur.playLikes += h.playLikes || 0;
      cur.playedAt = Math.min(cur.playedAt, h.playedAt);
      cur.addedAt = Math.min(cur.addedAt, h.addedAt || h.playedAt);
    }
  }
  let list = [...byId.values()].filter((h) => likesOf(h, likeType) >= minLikes);
  const L = (h) => likesOf(h, likeType);
  const sorters = {
    likes_desc: (a, b) => L(b) - L(a) || a.playedAt - b.playedAt,
    likes_asc: (a, b) => L(a) - L(b) || a.playedAt - b.playedAt,
    played_asc: (a, b) => a.playedAt - b.playedAt,
    played_desc: (a, b) => b.playedAt - a.playedAt,
    added_asc: (a, b) => a.addedAt - b.addedAt,
    added_desc: (a, b) => b.addedAt - a.addedAt,
  };
  list.sort(sorters[opts.order] || sorters.played_asc);
  return list;
}
