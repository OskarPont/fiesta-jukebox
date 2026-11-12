import { DEFAULT_SETTINGS } from './store.js';
import { summarize } from './library.js';
import { cleanName, randId, randPin, randToken, safeEqual } from './util.js';

export class PartyError extends Error {
  constructor(status, code, message, data = {}) {
    super(message);
    this.status = status; this.code = code; this.data = data;
  }
}

const ACTIVE_MS = 10 * 60 * 1000;
const KNOWN_TTL_MS = 60 * 60 * 1000;
const HISTORY_MAX = 500;
const RESTORE_TTL_MS = 30 * 1000;
const FAREWELL_TTL_MS = 24 * 60 * 60 * 1000;

const SETTING_RULES = {
  pauseMode: { type: 'enum', values: ['direct', 'admin'] },
  skipMode: { type: 'enum', values: ['direct', 'vote', 'admin'] },
  skipVoteMode: { type: 'enum', values: ['pct', 'fixed'] },
  skipVotePct: { type: 'int', min: 10, max: 100 },
  skipVoteFixed: { type: 'int', min: 1, max: 20 },
  maxQueuedPerGuest: { type: 'int', min: 1, max: 20 },
  addCooldownSec: { type: 'int', min: 0, max: 300 },
  controlCooldownSec: { type: 'int', min: 0, max: 600 },
  globalControlCooldownSec: { type: 'int', min: 0, max: 300 },
  ordering: { type: 'enum', values: ['votes', 'fifo'] },
  allowExplicit: { type: 'bool' },
  maxDurationMin: { type: 'int', min: 1, max: 60 },
  noRepeatMin: { type: 'int', min: 0, max: 1440 },
  allowAdd: { type: 'bool' },
};

export function validateSettings(partial) {
  if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
    throw new PartyError(400, 'bad_settings', 'Ajustes no válidos.');
  }
  const out = {};
  for (const [k, v] of Object.entries(partial)) {
    const rule = SETTING_RULES[k];
    if (!rule) throw new PartyError(400, 'bad_settings', `Ajuste desconocido: ${k}.`);
    if (rule.type === 'enum') {
      if (!rule.values.includes(v)) throw new PartyError(400, 'bad_settings', `Valor no válido para ${k}.`);
    } else if (rule.type === 'bool') {
      if (typeof v !== 'boolean') throw new PartyError(400, 'bad_settings', `Valor no válido para ${k}.`);
    } else if (rule.type === 'int') {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < rule.min || v > rule.max) {
        throw new PartyError(400, 'bad_settings', `${k} debe ser un número entre ${rule.min} y ${rule.max}.`);
      }
    }
    out[k] = v;
  }
  return out;
}

export class Party {
  /**
   * @param {object} opts
   * @param {object} opts.state estado mutable (store.state)
   * @param {Function} [opts.now]
   * @param {Function} [opts.onDirty] se llama tras cambios que hay que persistir
   */
  constructor({ state, now = Date.now, onDirty = () => {} }) {
    this.s = state;
    this.now = now;
    this.dirty = onDirty;
    this.lastRemoved = null;      // { item, at } de la última baja del anfitrión (solo memoria)
    this.lastCleared = null;      // { items, at } del último «Vaciar cola» (solo memoria)
    this.connected = new Map();   // guestId -> nº conexiones SSE
    this.known = new Map();       // trackId -> {meta, at}
    this.pinFails = [];
    this.joinBlockedUntil = 0;
    this.lastBlockAlertAt = 0;
  }

  get settings() { return this.s.settings; }
  get active() { return !!(this.s.party && this.s.party.active); }

  // ---------- ajustes ----------
  updateSettings(partial) {
    const clean = validateSettings(partial);
    Object.assign(this.s.settings, clean);
    this.dirty();
    return this.s.settings;
  }
  resetSettings() { this.s.settings = { ...DEFAULT_SETTINGS }; this.dirty(); }

  // ---------- fiesta ----------
  startParty(name) {
    if (this.active) throw new PartyError(409, 'already_active', 'Ya hay una fiesta en marcha.');
    const nm = cleanName(name, 40) || 'Fiesta';
    this.s.party = { id: randId(10), active: true, pin: randPin(), startedAt: this.now(), name: nm };
    this.s.guests = {};
    this.s.queue = this.s.queue.filter((i) => i.fed);
    this.s.history = [];
    this.s.lastGlobalControlAt = 0;
    this.pinFails = []; this.joinBlockedUntil = 0;
    if (this.s.nowPlaying) this.s.nowPlaying.skipVotes = [];
    this.dirty();
    return this.s.party;
  }

  renameParty(name) {
    if (!this.s.party) throw new PartyError(409, 'no_party', 'No hay fiesta.');
    const nm = cleanName(name, 40);
    if (!nm) throw new PartyError(400, 'bad_name', 'El nombre de la fiesta no puede estar vacío.');
    this.s.party.name = nm; this.dirty();
    return nm;
  }

  stopParty({ kickAll = true } = {}) {
    if (!this.s.party) return null;
    this.s.party.active = false;
    this.s.party.endedAt = this.now();
    // token -> id de invitado, para que su despedida sobreviva a la expulsion (los tokens solo se guardan en el servidor)
    const tokens = {};
    for (const [token, g] of Object.entries(this.s.guests)) if (g.partyId === this.s.party.id) tokens[token] = g.id;
    this.s.party.farewell = { tokens };
    if (kickAll) this.s.guests = {};
    this.s.queue = this.s.queue.filter((i) => i.fed);
    this.dirty();
    return this.s.party;
  }

  regenPin({ kickAll = false } = {}) {
    if (!this.active) throw new PartyError(409, 'no_party', 'No hay fiesta en marcha.');
    let pin;
    do { pin = randPin(); } while (pin === this.s.party.pin);
    this.s.party.pin = pin;
    if (kickAll) {
      for (const [t, g] of Object.entries(this.s.guests)) if (!g.banned) delete this.s.guests[t];
    }
    this.pinFails = []; this.joinBlockedUntil = 0;
    this.dirty();
    return pin;
  }

  // ---------- invitados ----------
  getGuest(token) {
    if (!token || !this.active) return null;
    const g = this.s.guests[token];
    if (!g || g.banned || g.partyId !== this.s.party.id) return null;
    return g;
  }
  /** true si el token es de un invitado baneado de esta fiesta. */
  isBanned(token) {
    const g = token && this.s.guests[token];
    return !!(g && g.banned && this.active && g.partyId === this.s.party.id);
  }
  guestById(id) {
    for (const [token, g] of Object.entries(this.s.guests)) if (g.id === id) return { token, guest: g };
    return null;
  }
  touch(guest) { guest.lastSeen = this.now(); }

  join({ pin, name, token }) {
    if (!this.active) throw new PartyError(409, 'no_party', 'Ahora mismo no hay fiesta.');
    const t = this.now();
    if (this.joinBlockedUntil > t) {
      throw new PartyError(429, 'join_blocked', 'Demasiados intentos. Espera un par de minutos.');
    }
    const nm = cleanName(name);
    if (!nm) throw new PartyError(400, 'bad_name', 'Escribe tu nombre (hasta 24 caracteres).');
    if (this.isBanned(token)) throw new PartyError(403, 'banned', 'No puedes entrar a esta fiesta.');
    const existing = this.getGuest(token);
    if (!existing) {
      const ok = typeof pin === 'string' && /^\d{4}$/.test(pin) && safeEqual(pin, this.s.party.pin);
      if (!ok) {
        this.pinFails = this.pinFails.filter((x) => t - x < 10 * 60 * 1000);
        this.pinFails.push(t);
        if (this.pinFails.length >= 20) {
          this.joinBlockedUntil = t + 2 * 60 * 1000;
          this.lastBlockAlertAt = t;
          this.pinFails = [];
        }
        throw new PartyError(403, 'bad_pin', 'PIN incorrecto. Míralo en la pantalla o en el QR.');
      }
    }
    const finalName = this._uniqueName(nm, existing);
    if (existing) {
      existing.name = finalName;
      this.touch(existing);
      for (const q of this.s.queue) if (q.addedBy.id === existing.id) q.addedBy.name = finalName;
      this.dirty();
      return { guest: existing, token, created: false };
    }
    const newToken = randToken(32);
    const guest = {
      id: randId(8), name: finalName, joinedAt: t, lastSeen: t, banned: false,
      partyId: this.s.party.id, lastAddAt: 0, lastControlAt: 0, added: 0,
    };
    this.s.guests[newToken] = guest;
    this.s.party.joined = (this.s.party.joined || 0) + 1;
    this.dirty();
    return { guest, token: newToken, created: true };
  }

  _uniqueName(base, self) {
    const taken = new Set(Object.values(this.s.guests).filter((g) => g !== self && !g.banned).map((g) => g.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; n < 1000; n++) {
      const suffix = ` ${n}`;
      const chars = [...base];
      const cand = (chars.length + suffix.length > 24 ? chars.slice(0, 24 - suffix.length).join('').trim() : base) + suffix;
      if (!taken.has(cand.toLowerCase())) return cand;
    }
    return base;
  }

  kick(id) {
    const f = this.guestById(id);
    if (!f) throw new PartyError(404, 'not_found', 'Invitado no encontrado.');
    delete this.s.guests[f.token];
    this.connected.delete(id);
    this.dirty();
    return f.guest;
  }
  ban(id) {
    const f = this.guestById(id);
    if (!f) throw new PartyError(404, 'not_found', 'Invitado no encontrado.');
    f.guest.banned = true;
    this.s.queue = this.s.queue.filter((q) => q.fed || q.addedBy.id !== id);
    for (const q of this.s.queue) q.votes = q.votes.filter((v) => v !== id);
    if (this.s.nowPlaying) {
      this.s.nowPlaying.skipVotes = (this.s.nowPlaying.skipVotes || []).filter((v) => v !== id);
      this.s.nowPlaying.playLikes = (this.s.nowPlaying.playLikes || []).filter((v) => v !== id);
    }
    this.connected.delete(id);
    this.dirty();
    return f.guest;
  }

  setConnected(guestId, delta) {
    const n = Math.max(0, (this.connected.get(guestId) || 0) + delta);
    if (n === 0) this.connected.delete(guestId); else this.connected.set(guestId, n);
  }
  isGuestActive(g) {
    return this.connected.has(g.id) || this.now() - g.lastSeen < ACTIVE_MS;
  }
  presentGuests() {
    return Object.values(this.s.guests).filter((g) => !g.banned && this.active && g.partyId === this.s.party.id);
  }
  activeCount() { return this.presentGuests().filter((g) => this.isGuestActive(g)).length; }

  // ---------- catalogo conocido (solo se aceptan canciones devueltas por busquedas) ----------
  rememberTracks(tracks) {
    const t = this.now();
    for (const tr of tracks) this.known.set(tr.trackId, { meta: tr, at: t });
    if (this.known.size > 5000) this.pruneKnown();
  }
  pruneKnown() {
    const t = this.now();
    for (const [k, v] of this.known) if (t - v.at > KNOWN_TTL_MS) this.known.delete(k);
  }
  knownByUri(uri) {
    const m = /^spotify:track:([A-Za-z0-9]{10,32})$/.exec(String(uri || ''));
    if (!m) return null;
    const e = this.known.get(m[1]);
    if (!e) return null;
    if (this.now() - e.at > KNOWN_TTL_MS) { this.known.delete(m[1]); return null; }
    return e.meta;
  }

  // ---------- cola ----------
  isRecent(trackId) {
    const st = this.settings;
    const np = this.s.nowPlaying;
    if (np && np.trackId === trackId) return 'now';
    if (this.s.fed && this.s.fed.trackId === trackId) return 'queue';
    if (st.noRepeatMin <= 0) return null;
    const limit = this.now() - st.noRepeatMin * 60000;
    for (let i = this.s.history.length - 1; i >= 0; i--) {
      const h = this.s.history[i];
      if (h.playedAt < limit) break;
      if (h.trackId === trackId) return 'recent';
    }
    return null;
  }

  guestQueued(guestId) { return this.s.queue.filter((q) => q.addedBy.id === guestId).length; }
  quotaLeft(guest) { return Math.max(0, this.settings.maxQueuedPerGuest - this.guestQueued(guest.id)); }

  /** Estado de una cancion para un invitado (para anotar resultados de busqueda). */
  annotate(track, guest) {
    const st = this.settings;
    const inQueue = this.s.queue.some((q) => q.trackId === track.trackId);
    const rec = this.isRecent(track.trackId);
    let blocked = null;
    if (!st.allowExplicit && track.explicit) blocked = 'explicit';
    else if (track.durationMs > st.maxDurationMin * 60000) blocked = 'long';
    return { inQueue, recentlyPlayed: rec === 'recent' || rec === 'now', blocked };
  }

  checkAdd(guest, track) {
    const st = this.settings;
    if (!this.active) throw new PartyError(409, 'no_party', 'La fiesta no está activa.');
    if (!st.allowAdd) throw new PartyError(403, 'closed', 'La cola está cerrada ahora mismo.');
    if (!track) throw new PartyError(400, 'unknown_track', 'No encuentro esa canción. Búscala otra vez.');
    if (!st.allowExplicit && track.explicit) throw new PartyError(403, 'explicit', 'No se admiten canciones explícitas.');
    if (track.durationMs > st.maxDurationMin * 60000) {
      throw new PartyError(403, 'too_long', `Esa canción dura más de ${st.maxDurationMin} minutos.`);
    }
    if (this.s.queue.some((q) => q.trackId === track.trackId)) {
      throw new PartyError(409, 'duplicate', 'Esa canción ya está en la cola.');
    }
    const rec = this.isRecent(track.trackId);
    if (rec === 'now') throw new PartyError(409, 'recent', 'Esa canción está sonando ahora.');
    if (rec === 'queue') throw new PartyError(409, 'duplicate', 'Esa canción ya está en la cola.');
    if (rec === 'recent') throw new PartyError(409, 'recent', 'Esa canción sonó hace poco.');
    if (this.guestQueued(guest.id) >= st.maxQueuedPerGuest) {
      throw new PartyError(429, 'limit', `Ya tienes ${st.maxQueuedPerGuest} canciones en cola. Espera a que suene alguna.`);
    }
    const wait = guest.lastAddAt + st.addCooldownSec * 1000 - this.now();
    if (wait > 0) {
      throw new PartyError(429, 'cooldown', `Espera ${Math.ceil(wait / 1000)} s para añadir otra.`, { retryInSec: Math.ceil(wait / 1000) });
    }
  }

  addTrack(guest, uri) {
    const track = this.knownByUri(uri);
    this.checkAdd(guest, track);
    const item = {
      qid: randId(10), uri: track.uri, trackId: track.trackId, name: track.name, artists: track.artists,
      album: track.album, image: track.image, thumb: track.thumb, durationMs: track.durationMs,
      explicit: !!track.explicit, addedBy: { id: guest.id, name: guest.name }, addedAt: this.now(),
      votes: [], fed: false, manual: null,
    };
    this.s.queue.push(item);
    guest.lastAddAt = this.now();
    guest.added = (guest.added || 0) + 1;
    this.dirty();
    return item;
  }

  findItem(qid) { return this.s.queue.find((q) => q.qid === qid) || null; }

  removeTrack(qid, guest /* null = admin */) {
    const item = this.findItem(qid);
    if (!item) throw new PartyError(404, 'not_found', 'Esa canción ya no está en la cola.');
    if (item.fed) throw new PartyError(409, 'fed', 'Esa canción ya está lista en Spotify y no se puede quitar.');
    if (guest && item.addedBy.id !== guest.id) throw new PartyError(403, 'forbidden', 'Solo puedes quitar tus canciones.');
    this.s.queue = this.s.queue.filter((q) => q !== item);
    // Solo la baja del anfitrión se puede deshacer; vive en memoria, no se persiste.
    if (!guest) this.lastRemoved = { item, at: this.now() };
    this.dirty();
    return item;
  }

  /**
   * Deshace la última baja del anfitrión (30 s). Se devuelve el MISMO objeto, con votos,
   * addedAt, manual y addedBy, así orderedQueue() la coloca donde estaba. Si hubo un
   * adminReorder entre medias, los `manual` pueden coincidir con los de otros items; es
   * aceptable (el orden entre empates queda estable por el sort).
   */
  restoreTrack(qid) {
    const lr = this.lastRemoved;
    if (!lr || lr.item.qid !== qid || this.now() - lr.at > RESTORE_TTL_MS || this.findItem(qid)) {
      throw new PartyError(409, 'cant_restore', 'Ya no se puede deshacer.');
    }
    this.s.queue.push(lr.item);
    this.lastRemoved = null;
    this.dirty();
    return lr.item;
  }

  vote(guest, qid, on = true) {
    const item = this.findItem(qid);
    if (!item) throw new PartyError(404, 'not_found', 'Esa canción ya no está en la cola.');
    if (item.fed) throw new PartyError(409, 'fed', 'Esa canción va a sonar ya, no se puede votar.');
    if (item.addedBy.id === guest.id) throw new PartyError(403, 'own_song', 'No puedes votar tu propia canción.');
    const has = item.votes.includes(guest.id);
    if (on && !has) item.votes.push(guest.id);
    if (!on && has) item.votes = item.votes.filter((v) => v !== guest.id);
    this.dirty();
    return item;
  }

  orderedQueue() {
    const q = this.s.queue;
    const ordinal = new Map();
    const counts = {};
    [...q].sort((a, b) => a.addedAt - b.addedAt).forEach((i) => {
      const n = counts[i.addedBy.id] || 0; counts[i.addedBy.id] = n + 1; ordinal.set(i, n);
    });
    const fed = q.filter((i) => i.fed);
    const rest = q.filter((i) => !i.fed);
    const manual = rest.filter((i) => i.manual != null).sort((a, b) => a.manual - b.manual);
    const auto = rest.filter((i) => i.manual == null);
    if (this.settings.ordering === 'fifo') {
      auto.sort((a, b) => a.addedAt - b.addedAt);
    } else {
      const score = (i) => i.votes.length - (ordinal.get(i) >= 1 ? 0.5 : 0);
      auto.sort((a, b) => score(b) - score(a) || a.addedAt - b.addedAt);
    }
    return [...fed, ...manual, ...auto];
  }
  nextToFeed() { return this.orderedQueue().find((i) => !i.fed) || null; }

  adminTop(qid) {
    const item = this.findItem(qid);
    if (!item) throw new PartyError(404, 'not_found', 'Esa canción ya no está en la cola.');
    if (item.fed) throw new PartyError(409, 'fed', 'Esa canción ya es la siguiente.');
    const ranks = this.s.queue.filter((q) => q.manual != null).map((q) => q.manual);
    const min = ranks.length ? Math.min(...ranks) : 1;
    item.manual = min - 1;
    this.dirty();
  }
  adminReorder(qids) {
    if (!Array.isArray(qids)) throw new PartyError(400, 'bad_request', 'Lista no válida.');
    const set = new Set();
    for (const id of qids) {
      const it = this.findItem(id);
      if (it && !it.fed && !set.has(id)) set.add(id);
    }
    for (const q of this.s.queue) q.manual = null;
    let n = 1;
    for (const id of set) this.findItem(id).manual = n++;
    this.dirty();
  }
  clearQueue() {
    // se guardan las vaciadas 30 s para poder deshacer (#39); la ya enviada a Spotify no se vacía
    const gone = this.s.queue.filter((q) => !q.fed);
    this.lastCleared = gone.length ? { items: gone, at: this.now() } : null;
    this.s.queue = this.s.queue.filter((q) => q.fed);
    this.dirty();
    return gone.length;
  }
  /** Deshace «Vaciar cola»: vuelven los mismos objetos (votos, addedAt, manual) y por tanto su puesto. */
  restoreCleared() {
    const lc = this.lastCleared;
    if (!lc || this.now() - lc.at > RESTORE_TTL_MS) throw new PartyError(409, 'cant_restore', 'Ya no se puede deshacer.');
    let n = 0;
    for (const it of lc.items) if (!this.findItem(it.qid)) { this.s.queue.push(it); n++; }
    this.lastCleared = null;
    this.dirty();
    return n;
  }

  // ---------- likes a la que suena ----------
  likeNow(guest, on = true) {
    const np = this.s.nowPlaying;
    if (!np) throw new PartyError(409, 'nothing_playing', 'No hay nada sonando.');
    if (np.fromQueue?.addedBy?.id === guest.id) throw new PartyError(403, 'own_song', 'Es tu canción: los likes son para los demás.');
    np.playLikes = np.playLikes || [];
    const has = np.playLikes.includes(guest.id);
    if (on && !has) np.playLikes.push(guest.id);
    if (!on && has) np.playLikes = np.playLikes.filter((v) => v !== guest.id);
    this.dirty();
    return { liked: np.playLikes.includes(guest.id), likes: np.playLikes.length };
  }

  /** Historial de la fiesta activa (o del ultimo periodo si no hay fiesta). */
  partyHistory() {
    const p = this.s.party;
    if (!p) return [];
    return this.s.history.filter((h) => h.partyId === p.id || (!h.partyId && h.playedAt >= p.startedAt && (!p.endedAt || h.playedAt <= p.endedAt)));
  }

  /**
   * Despedida que ve un invitado en el movil al terminar la fiesta. Solo llega a invitados de esa fiesta:
   * null si no procede o si el token no es de uno de ellos (GET /api/party es publico y el resumen lleva nombres).
   * Nada de ids, PIN ni tokens, y las cifras personales son solo las de ese invitado.
   */
  farewellFor(token) {
    const p = this.s.party;
    if (!p || p.active || !p.endedAt || this.now() - p.endedAt > FAREWELL_TTL_MS) return null;
    const gid = (token && p.farewell?.tokens?.[token]) || (token && this.s.guests[token]?.partyId === p.id ? this.s.guests[token].id : null);
    if (!gid) return null;
    const hist = this.partyHistory();
    const sm = summarize(hist, p);
    const own = hist.filter((h) => h.addedBy?.id === gid);
    const likes = own.reduce((n, h) => n + (h.playLikes || 0), 0);
    const votes = own.reduce((n, h) => n + (h.queueLikes || 0), 0);
    const top = own.filter((h) => (h.playLikes || 0) + (h.queueLikes || 0) > 0)
      .sort((a, b) => (b.playLikes || 0) - (a.playLikes || 0) || (b.queueLikes || 0) - (a.queueLikes || 0) || a.playedAt - b.playedAt)[0];
    const s1 = sm.songOfNight;
    return {
      name: p.name || null, endedAt: p.endedAt, songs: sm.songs,
      songOfNight: s1 && { name: s1.name, artists: s1.artists, image: s1.image, addedBy: s1.addedBy, likes: s1.playLikes, votes: s1.queueLikes },
      dj: sm.bestDj && { name: sm.bestDj.name, likes: sm.bestDj.likes, votes: sm.bestDj.votes },
      mine: {
        songs: own.length, likes, votes,
        best: top ? { name: top.name, likes: top.playLikes || 0, votes: top.queueLikes || 0 } : null,
      },
    };
  }

  // ---------- historial ----------
  pushHistory(entry) {
    if (this.active && !entry.partyId) entry.partyId = this.s.party.id;
    this.s.history.push(entry);
    if (this.s.history.length > HISTORY_MAX) this.s.history.splice(0, this.s.history.length - HISTORY_MAX);
    this.dirty();
  }

  // ---------- control directo / votos de salto ----------
  controlWait(guest, kind /* 'pause' | 'skip' */) {
    const st = this.settings;
    const t = this.now();
    const mine = guest.lastControlAt + st.controlCooldownSec * 1000 - t;
    const glob = this.s.lastGlobalControlAt + st.globalControlCooldownSec * 1000 - t;
    const wait = Math.max(mine, glob, 0);
    return { waitMs: wait, own: mine > 0 && mine >= glob };
  }
  checkDirectControl(guest) {
    const { waitMs, own } = this.controlWait(guest);
    if (waitMs > 0) {
      const s = Math.ceil(waitMs / 1000);
      throw new PartyError(429, 'cooldown', own ? `Espera ${s} s para volver a usar los controles.` : `Alguien acaba de usar los controles. Espera ${s} s.`, { retryInSec: s });
    }
  }
  markControl(guest) {
    guest.lastControlAt = this.now();
    this.s.lastGlobalControlAt = this.now();
  }

  skipNeeded() {
    const st = this.settings;
    const active = this.activeCount();
    if (st.skipVoteMode === 'fixed') return Math.max(1, Math.min(st.skipVoteFixed, active));
    return Math.max(1, Math.ceil((active * st.skipVotePct) / 100));
  }
  currentSkipVotes() {
    const np = this.s.nowPlaying;
    if (!np) return [];
    const present = new Set(this.presentGuests().map((g) => g.id));
    return (np.skipVotes || []).filter((id) => present.has(id));
  }
  /** Registra o retira voto de salto. Devuelve {reached, votes, needed, voted}. */
  skipVote(guest, on = true) {
    const np = this.s.nowPlaying;
    if (!np) throw new PartyError(409, 'nothing_playing', 'No hay nada sonando.');
    np.skipVotes = np.skipVotes || [];
    const has = np.skipVotes.includes(guest.id);
    if (on && !has) np.skipVotes.push(guest.id);
    if (!on && has) np.skipVotes = np.skipVotes.filter((v) => v !== guest.id);
    const votes = this.currentSkipVotes().length;
    const needed = this.skipNeeded();
    this.dirty();
    return { reached: on && votes >= needed, votes, needed, voted: np.skipVotes.includes(guest.id) };
  }
}
