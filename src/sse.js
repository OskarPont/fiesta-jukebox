import crypto from 'node:crypto';
import { summarize, scoreOf } from './library.js';

export function securityHeaders() {
  return {
    'Content-Security-Policy': "default-src 'self'; img-src 'self' https://*.scdn.co https://*.spotifycdn.com data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    'Referrer-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
  };
}

const pubTrack = (q, viewerId) => ({
  qid: q.qid, uri: q.uri, trackId: q.trackId, name: q.name, artists: q.artists, album: q.album,
  image: q.image, thumb: q.thumb, durationMs: q.durationMs, explicit: q.explicit,
  addedBy: q.addedBy, addedAt: q.addedAt, fed: !!q.fed,
  votes: q.votes.length, voted: viewerId ? q.votes.includes(viewerId) : false,
  mine: viewerId ? q.addedBy.id === viewerId : false,
});

/** Parte comun (sin datos de un invitado concreto). */
export function buildCommon(ctx) {
  const { store, party, spotify, config, engine, library } = ctx;
  const s = store.state;
  const np = s.nowPlaying;
  const settings = s.settings;
  const present = party.presentGuests();
  const needed = party.skipNeeded();
  const skipVotes = party.currentSkipVotes();
  const ordered = party.orderedQueue();
  const tok = spotify.tokens;
  const authorizedAt = tok?.authorizedAt || null;
  const expiresAt = authorizedAt ? authorizedAt + 180 * 24 * 3600 * 1000 : null;
  const daysLeft = expiresAt ? Math.floor((expiresAt - Date.now()) / 86400000) : null;

  const alerts = [];
  if (daysLeft !== null && spotify.connected && daysLeft < 14) alerts.push({ level: 'warn', text: `La conexión con Spotify caduca en ${Math.max(0, daysLeft)} días. Pulsa "Reconectar Spotify".` });
  if (party.joinBlockedUntil > Date.now() || (party.lastBlockAlertAt && Date.now() - party.lastBlockAlertAt < 10 * 60000)) alerts.push({ level: 'warn', text: 'Muchos PIN incorrectos seguidos: las entradas se bloquearon 2 minutos. Si no eres tú, cambia el PIN.' });
  if (s.player.status === 'premium_required') alerts.push({ level: 'error', text: 'Spotify dice que hace falta Premium para controlar la reproducción.' });
  for (const f of spotify.disabled) alerts.push({ level: 'warn', text: `Función desactivada por Spotify: ${f}.` });

  return {
    party: s.party ? { active: !!s.party.active, name: s.party.name, startedAt: s.party.startedAt } : { active: false, name: null },
    settings,
    nowPlaying: np ? {
      trackId: np.trackId, name: np.name, artists: np.artists, album: np.album, image: np.image, durationMs: np.durationMs,
      progressMs: np.progressMs, isPlaying: np.isPlaying, at: np.at, fromQueue: np.fromQueue,
      skipVotes, skipNeeded: needed,
      playLikes: np.playLikes || [], queueLikes: np.queueLikes || 0, filler: np.fromQueue ? null : (np.filler || 'host'),
    } : null,
    queue: ordered,
    history: s.history,
    player: { status: s.player.status, deviceName: s.player.deviceName, volume: s.player.volume, supportsVolume: s.player.supportsVolume !== false && !s.player.isIphone, isIphone: !!s.player.isIphone, pausedByUs: !!s.pausedByUs },
    filler: np && np.isPlaying && !np.fromQueue ? (np.filler || 'host') : null,
    timeScale: engine.scale,
    publicUrl: config.PUBLIC_URL,
    publicHost: config.PUBLIC_URL.replace(/^https?:\/\//, ''),
    activeGuests: present.filter((g) => party.isGuestActive(g)).length,
    skipNeeded: needed,
    lastGlobalControlAt: s.lastGlobalControlAt,
    admin: {
      pin: s.party?.active ? s.party.pin : null,
      guests: present.concat(Object.values(s.guests).filter((g) => g.banned && g.partyId === s.party?.id)).map((g) => ({
        id: g.id, name: g.name, active: party.isGuestActive(g), banned: !!g.banned,
        added: g.added || 0, queued: party.guestQueued(g.id), joinedAt: g.joinedAt,
      })),
      spotify: {
        configured: spotify.configured, connected: spotify.connected, mock: config.MOCK, userName: tok?.userName || null,
        authorizedAt, expiresAt, daysLeft, redirectUri: config.REDIRECT_URI, hasCreds: !!spotify.creds?.clientId,
        clientIdHint: spotify.creds?.clientId ? spotify.creds.clientId.slice(0, 4) + '...' : null,
        rateLimitedMs: spotify.rateLimitedMs,
      },
      chosenDeviceId: s.chosenDeviceId,
      joinBlockedUntil: party.joinBlockedUntil,
      alerts,
      ...adminExtras(ctx),
    },
  };
}

/** Datos solo para el anfitrion: resumen, historial con likes, fiestas pasadas y clasicos. */
function adminExtras({ store, party, library }) {
  const s = store.state;
  const st = s.settings;
  let summary = null;
  if (s.party?.active) {
    const joined = Math.max(s.party.joined || 0, Object.values(s.guests).filter((g) => g.partyId === s.party.id).length);
    summary = { ...summarize(party.partyHistory(), { ...s.party, joined }), live: true, partyId: s.party.id };
  } else if (library?.data.parties[0]) {
    const p = library.data.parties[0];
    summary = { ...summarize(p.history, p), live: false, partyId: p.id };
  }
  const hist = s.party?.active ? party.partyHistory() : [];
  const classics = library ? library.classics({ minScore: st.classicsMinScore, limit: 100 }) : [];
  const excluded = library ? Object.values(library.data.tracks).filter((t) => t.excluded).length : 0;
  return {
    summary,
    showSummary: !!s.showSummary,
    history: hist.slice(-500).reverse().map(adminHist),
    parties: library ? library.listParties() : [],
    classics: {
      count: classics.length, excluded, tracksKnown: library ? Object.keys(library.data.tracks).length : 0,
      playlist: library?.data.classics || null,
      top: classics.slice(0, 30).map((t) => ({
        trackId: t.trackId, name: t.name, artists: t.artists, image: t.image,
        plays: t.plays, queueLikes: t.queueLikes, playLikes: t.playLikes, score: scoreOf(t),
      })),
    },
  };
}

export const adminHist = (h) => ({
  trackId: h.trackId, name: h.name, artists: h.artists, image: h.image,
  addedBy: h.addedBy ? h.addedBy.name : null, playedAt: h.playedAt, addedAt: h.addedAt || null,
  queueLikes: h.queueLikes || 0, playLikes: h.playLikes || 0, filler: h.addedBy ? null : (h.filler || 'host'), skipped: !!h.skipped,
});

const volatileKeys = new Set(['progressMs', 'at']);
function hashOf(common) {
  const json = JSON.stringify(common, (k, v) => (volatileKeys.has(k) ? undefined : v));
  return crypto.createHash('md5').update(json).digest('hex');
}

export function forViewer(common, viewer, ctx) {
  const { party } = ctx;
  const guest = viewer.guestToken ? party.getGuest(viewer.guestToken) : null;
  const gid = guest?.id || null;
  const st = common.settings;
  const nowMs = Date.now();
  let me = null;
  if (guest) {
    const own = guest.lastControlAt + st.controlCooldownSec * 1000;
    const glob = common.lastGlobalControlAt + st.globalControlCooldownSec * 1000;
    me = {
      id: guest.id, name: guest.name,
      queued: party.guestQueued(guest.id), quota: party.quotaLeft(guest),
      addCooldownUntil: guest.lastAddAt + st.addCooldownSec * 1000,
      controlCooldownUntil: Math.max(own, glob),
      skipVoted: !!(common.nowPlaying && common.nowPlaying.skipVotes.includes(gid)),
    };
  }
  let np = null;
  if (common.nowPlaying) {
    const c = common.nowPlaying;
    const { playLikes, ...rest } = c;
    np = { ...rest, skipVotes: c.skipVotes.length, likes: playLikes.length, liked: gid ? playLikes.includes(gid) : false };
    if (viewer.isAdmin) np.playLikes = playLikes.length; else delete np.queueLikes;
  }
  const out = {
    serverNow: nowMs,
    party: common.party,
    settings: common.settings,
    nowPlaying: np,
    queue: common.queue.map((q) => pubTrack(q, gid)),
    history: common.history.slice(-(viewer.isAdmin ? 100 : 20)).reverse().map((h) => ({
      trackId: h.trackId, name: h.name, artists: h.artists, image: h.image, addedBy: h.addedBy ? h.addedBy.name : null, playedAt: h.playedAt,
    })),
    player: viewer.isAdmin || !(common.player.status === 'no_device' && !common.queue.length && !common.nowPlaying) ? common.player : { ...common.player, status: 'idle' },
    filler: common.filler,
    timeScale: common.timeScale,
    publicUrl: common.publicUrl,
    publicHost: common.publicHost,
    activeGuests: common.activeGuests,
    skipNeeded: common.skipNeeded,
    me,
    isAdmin: !!viewer.isAdmin,
  };
  if (viewer.isAdmin) out.admin = common.admin;
  else if (!common.party.active) out.farewell = party.farewellFor(viewer.guestToken);
  return out;
}

export class Hub {
  constructor({ ctx, hbMs = 20000 }) {
    this.ctx = ctx; this.clients = new Set();
    this.timer = null; this.last = 0; this.force = false; this.lastHash = null;
    this.hb = setInterval(() => this.heartbeat(), hbMs);
    this.hb.unref?.();
  }
  hasClients() { return this.clients.size > 0; }

  heartbeat() {
    for (const c of [...this.clients]) {
      if (!this.write(c, ':hb\n\n')) continue;
      if (c.guestToken) { const g = this.ctx.party.getGuest(c.guestToken); if (g) this.ctx.party.touch(g); }
    }
  }

  write(c, chunk) {
    try {
      if (c.res.destroyed || c.res.writableEnded) throw new Error('closed');
      c.res.write(chunk);
      return true;
    } catch { this.remove(c); return false; }
  }

  add(req, reply, viewer, headers) {
    const res = reply.raw;
    reply.hijack();
    res.writeHead(200, {
      ...headers,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const c = { res, ...viewer };
    const guest = viewer.guestToken ? this.ctx.party.getGuest(viewer.guestToken) : null;
    c.guestId = guest?.id || null;
    if (c.guestId) this.ctx.party.setConnected(c.guestId, 1);
    this.clients.add(c);
    const cleanup = () => this.remove(c);
    req.raw.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
    this.sendState(c, buildCommon(this.ctx));
    this.changed(true);
  }

  remove(c) {
    if (!this.clients.delete(c)) return;
    if (c.guestId) this.ctx.party.setConnected(c.guestId, -1);
    try { c.res.end(); } catch { /* ignorar */ }
    this.changed();
  }

  sendState(c, common) {
    const data = forViewer(common, c, this.ctx);
    this.write(c, `event: state\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /** Difunde el estado (con throttle de 250 ms). force=true ignora el hash. */
  changed(force = false) {
    if (force) this.force = true;
    if (this.timer) return;
    const wait = Math.max(0, this.last + 250 - Date.now());
    this.timer = setTimeout(() => this.flush(), wait);
    this.timer.unref?.();
  }

  flush() {
    this.timer = null;
    this.last = Date.now();
    if (!this.clients.size) { this.force = false; return; }
    const common = buildCommon(this.ctx);
    const h = hashOf(common);
    if (!this.force && h === this.lastHash) return;
    this.force = false; this.lastHash = h;
    for (const c of [...this.clients]) this.sendState(c, common);
  }

  /** Aviso a todos. `by` = id del invitado al que se refiere (su cancion), para que cada app filtre lo suyo. */
  toast(text, kind = 'info', by = null) {
    const payload = `event: toast\ndata: ${JSON.stringify(by ? { text, kind, by } : { text, kind })}\n\n`;
    for (const c of [...this.clients]) this.write(c, payload);
  }

  /** Cierra conexiones de invitados (expulsion). pred(client) => bool */
  drop(pred) {
    for (const c of [...this.clients]) {
      if (c.isAdmin || !pred(c)) continue;
      this.write(c, 'event: kicked\ndata: {}\n\n');
      this.remove(c);
    }
  }

  close() {
    clearInterval(this.hb);
    for (const c of [...this.clients]) this.remove(c);
  }
}
