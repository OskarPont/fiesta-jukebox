import { Mutex } from './util.js';
import { normTrack, SpotifyError } from './spotify.js';

/** iPhone/iPad: Apple no deja controlar el volumen y duerme Spotify al pausar en segundo plano. */
export function isIphone(d) {
  if (!d) return false;
  if (/iphone|ipad|ios/i.test(d.name || '')) return true;
  return (d.type === 'Smartphone' || d.type === 'Tablet') && d.supports_volume === false;
}

const BASE_FAST = 3000;      // fiesta activa con clientes
const BASE_MID = 10000;      // fiesta activa sin clientes
const BASE_SLOW = 30000;     // sin fiesta
const QUEUE_CHECK_MIN = 30000;
const MIN_PLAYED_MS = 30000;

/**
 * Motor de reproduccion. La cola real es la nuestra; a Spotify se le da de comer
 * una cancion cada vez, justo antes de que haga falta.
 */
export class Engine {
  constructor({ store, party, spotify, library = null, onChange = () => {}, toast = () => {}, hasClients = () => false,
    now = Date.now, getScale = () => 1, feedLeadMs = 20000, autoTimers = true, log = () => {} }) {
    this.store = store; this.s = store.state; this.party = party; this.spotify = spotify; this.library = library;
    this.onChange = onChange; this.toast = toast; this.hasClients = hasClients;
    this.now = now; this.getScale = getScale; this.feedLead = feedLeadMs; this.autoTimers = autoTimers; this.log = log;
    this.lock = new Mutex();
    this.timer = null; this.running = false; this.stopped = true;
    this.pendingNudge = null;
    this.lastQueueCheck = 0; this.verifyAsap = false;
    this.lastDevicesAt = 0; this.nullSince = 0;
    this.lastError = null;
    this.forceBroadcast = false;
  }

  // ---------- utilidades ----------
  get scale() { return Math.max(1, this.getScale() || 1); }
  projected(np) {
    if (!np) return 0;
    if (!np.isPlaying) return np.progressMs || 0;
    return Math.min(np.durationMs, (np.progressMs || 0) + (this.now() - np.at) * this.scale);
  }
  remainingMs(np) { return np ? np.durationMs - this.projected(np) : Infinity; }

  setStatus(st) {
    if (this.s.player.status !== st) { this.s.player.status = st; this.onChange(true); }
  }

  onError(e) {
    this.lastError = e;
    const k = e?.kind;
    if (k === 'rate_limited') this.setStatus('rate_limited');
    else if (k === 'no_device') this.setStatus('no_device');
    else if (k === 'premium_required') this.setStatus('premium_required');
    else if (k === 'disconnected') this.setStatus('disconnected');
    else if (k === 'not_configured') this.setStatus('not_configured');
    else if (k === 'restriction') { /* ignorar: p. ej. pausar algo ya pausado */ }
    else this.log('[engine] error de Spotify:', e?.message);
  }

  // ---------- ciclo ----------
  start() {
    this.stopped = false;
    this.schedule(300);
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  baseInterval() {
    if (!this.party.active) return BASE_SLOW;
    return this.hasClients() ? BASE_FAST : BASE_MID;
  }

  computeDelay() {
    const sc = this.scale;
    let d = this.baseInterval() / sc;
    const np = this.s.nowPlaying;
    if (this.party.active && np && np.isPlaying) {
      const rem = this.remainingMs(np) / sc;          // ms reales hasta el final
      const toLead = rem - this.feedLead / sc;
      if (toLead > 30) d = Math.min(d, toLead + 50);
      if (rem + 1500 / sc > 30) d = Math.min(d, rem + 1500 / sc);
    }
    if (this.pendingNudge != null) d = Math.min(d, this.pendingNudge);
    const lim = this.spotify.rateLimitedMs;
    if (lim > 0) d = Math.max(d, lim + 250);
    return Math.max(30, d);
  }

  schedule(delay) {
    if (this.stopped || !this.autoTimers) return;
    if (this.running) { this.pendingNudge = Math.min(this.pendingNudge ?? Infinity, delay ?? 0); return; }
    if (this.timer) clearTimeout(this.timer);
    this.pendingNudge = null;
    const d = delay != null ? delay : this.computeDelay();
    this.timer = setTimeout(() => this.loop(), d);
    this.timer.unref?.();
  }

  async loop() {
    this.timer = null;
    try { await this.tick(); } catch (e) { this.log('[engine] tick fallo', e); }
    this.schedule(null);
  }

  /** Pide un tick pronto (acciones). */
  nudge(ms = 0) {
    if (this.stopped || !this.autoTimers) return;
    if (this.running) { this.pendingNudge = Math.min(this.pendingNudge ?? Infinity, ms); return; }
    this.schedule(Math.max(0, ms));
  }

  /** La cola cambio: solo vale la pena un tick si estamos cerca del final o parados. */
  poke() {
    const np = this.s.nowPlaying;
    if (!this.party.active) return;
    if (!np || !np.isPlaying || this.remainingMs(np) <= this.feedLead + 5000) this.nudge(150 / this.scale);
  }

  tick() { return this.lock.run(() => this._tick()); }

  async _tick() {
    this.running = true;
    try { await this._tickInner(); } finally { this.running = false; }
  }

  async _tickInner() {
    const s = this.s; const sp = this.spotify;
    if (!sp.configured) { this.setStatus('not_configured'); return; }
    if (!sp.connected) { this.setStatus('disconnected'); return; }
    if (sp.rateLimitedMs > 0) { this.setStatus('rate_limited'); return; }

    let pl;
    try { pl = await sp.getPlayer(); } catch (e) { this.onError(e); return; }
    this.lastError = null;

    this.applyPlayer(pl);
    this.setStatus(pl ? 'ok' : 'no_device');
    if (pl?.device) { s.player.deviceName = pl.device.name; s.player.volume = pl.device.volume_percent ?? s.player.volume; s.player.deviceId = pl.device.id; s.player.supportsVolume = pl.device.supports_volume !== false; s.player.isIphone = isIphone(pl.device); this.activeDeviceId = pl.device.id; }

    const np = s.nowPlaying;
    if (np && np.isPlaying && s.pausedByUs) s.pausedByUs = false;

    try {
      if (this.party.active) {
        const idle = this.isIdle(pl);
        await this.verifyFed(np, idle);
        if (!s.fed && np && np.isPlaying && this.remainingMs(np) <= this.feedLead) {
          const item = this.party.nextToFeed() || this.classicFiller();
          if (item) await this.feed(item);
        }
        if (idle && !s.fed) await this.coldStart(pl);
      }
    } catch (e) { this.onError(e); }

    this.onChange(this.forceBroadcast);
    this.forceBroadcast = false;
  }

  isIdle(pl) {
    const s = this.s;
    if (!pl) return true;
    if (pl.is_playing) return false;
    if (s.pausedByUs) return false;
    const prog = pl.progress_ms || 0;
    const dur = pl.item?.duration_ms || 0;
    return prog === 0 || !pl.item || (dur > 0 && prog >= dur - 1500);
  }

  // ---------- normalizar y detectar cambios ----------
  applyPlayer(pl) {
    const s = this.s; const t = this.now();
    const prev = s.nowPlaying;
    const item = pl?.item ? normTrack(pl.item) : null;

    if (!item) {
      if (prev) {
        prev.progressMs = Math.round(this.projected(prev)); prev.isPlaying = false; prev.at = t;
        if (!this.nullSince) this.nullSince = t;
        if (t - this.nullSince > 60000) {
          this.finishTrack(prev);
          s.nowPlaying = null; this.nullSince = 0; this.forceBroadcast = true;
        }
      }
      return;
    }
    this.nullSince = 0;

    const np = {
      trackId: item.trackId, uri: item.uri, name: item.name, artists: item.artists, album: item.album, image: item.image,
      durationMs: item.durationMs, progressMs: pl.progress_ms || 0, isPlaying: !!pl.is_playing, at: t,
      fromQueue: null, skipVotes: [], maxProgress: pl.progress_ms || 0, skipped: false,
      playLikes: [], queueLikes: 0, addedAt: null, filler: null,
    };

    let changed = !prev || prev.trackId !== np.trackId;
    if (!changed && prev) {
      const projPrev = this.projected(prev);
      const nearEnd = prev.durationMs - Math.max(prev.maxProgress || 0, projPrev) < this.feedLead + BASE_FAST * 2 + 5000;
      if (np.progressMs + 5000 < projPrev && nearEnd) changed = true;     // repeticion de la misma cancion
      else if (Math.abs(np.progressMs - projPrev) > 3000 && prev.isPlaying && np.isPlaying) this.forceBroadcast = true;
      if (prev.isPlaying !== np.isPlaying) this.forceBroadcast = true;
    }

    if (changed) {
      this.onTrackChange(prev, np);
      this.forceBroadcast = true;
    } else {
      np.fromQueue = prev.fromQueue; np.skipVotes = prev.skipVotes || []; np.skipped = prev.skipped;
      np.playLikes = prev.playLikes || []; np.queueLikes = prev.queueLikes || 0; np.addedAt = prev.addedAt || null; np.filler = prev.filler || null;
      np.maxProgress = Math.max(prev.maxProgress || 0, np.progressMs);
    }
    s.nowPlaying = np;
  }

  finishTrack(prev) {
    if (!prev) return;
    const played = Math.max(prev.maxProgress || 0, this.projected(prev));
    if (played > MIN_PLAYED_MS || prev.skipped) {
      const entry = {
        trackId: prev.trackId, uri: prev.uri, name: prev.name, artists: prev.artists, image: prev.image,
        durationMs: prev.durationMs || 0, addedBy: prev.fromQueue?.addedBy || null, playedAt: this.now(),
        addedAt: prev.addedAt || null, queueLikes: prev.queueLikes || 0, playLikes: (prev.playLikes || []).length,
        filler: prev.fromQueue ? null : (prev.filler || 'host'), skipped: !!prev.skipped,
      };
      const wasActive = this.party.active;
      this.party.pushHistory(entry);
      if (wasActive && this.library) this.library.recordPlay(entry);
    }
  }

  onTrackChange(prev, np) {
    const s = this.s;
    if (prev) this.finishTrack(prev);
    const fed = s.fed;
    if (fed && fed.trackId === np.trackId) {
      const item = s.queue.find((q) => q.qid === fed.qid);
      s.queue = s.queue.filter((q) => q.qid !== fed.qid);
      if (fed.filler === 'classic' || !fed.addedBy) {
        np.filler = 'classic';
      } else {
        np.fromQueue = { addedBy: fed.addedBy };
        np.queueLikes = item ? item.votes.length : (fed.queueLikes || 0);
        np.addedAt = item ? item.addedAt : (fed.addedAt || null);
      }
      s.fed = null;
      this.party.dirty();
      if (this.party.active && np.fromQueue) this.toast(`Ahora suena ${np.name} (de ${fed.addedBy.name})`, 'now');
    } else if (fed) {
      this.verifyAsap = true;
    }
    this.party.dirty();
  }

  // ---------- cola de Spotify ----------
  async verifyFed(np, idle) {
    const s = this.s; const fed = s.fed;
    if (!fed) return;
    if (np && np.trackId === fed.trackId) return;
    const t = this.now();
    const elapsed = (t - fed.fedAt) * this.scale;
    const due = elapsed > fed.durationMs + 15000 || this.verifyAsap || idle;
    if (!due) return;
    if (t - this.lastQueueCheck < QUEUE_CHECK_MIN / this.scale) return;
    this.lastQueueCheck = t;
    let q;
    try { q = await this.spotify.getQueue(); } catch (e) { this.onError(e); return; }
    this.verifyAsap = false;
    const has = (q?.queue || []).some((x) => x.id === fed.trackId) || q?.currently_playing?.id === fed.trackId;
    if (!has) {
      const item = s.queue.find((i) => i.qid === fed.qid);
      if (item) item.fed = false;
      s.fed = null;
      this.party.dirty();
      this.forceBroadcast = true;
      this.log('[engine] la cancion alimentada se perdió, se reintentará');
    }
  }

  markFed(item) {
    const s = this.s;
    item.fed = true;
    s.fed = { qid: item.qid, uri: item.uri, trackId: item.trackId, fedAt: this.now(), addedBy: item.addedBy, durationMs: item.durationMs, name: item.name, filler: item.filler || null, queueLikes: (item.votes || []).length, addedAt: item.addedAt || null };
    this.verifyAsap = false;
    this.party.dirty();
    this.forceBroadcast = true;
  }

  async feed(item) {
    await this.spotify.addToQueue(item.uri);
    this.markFed(item);
  }

  async chooseDevice(pl) {
    const s = this.s;
    if (pl?.device) return s.chosenDeviceId || pl.device.id;
    const t = this.now();
    if (t - this.lastDevicesAt < 5000 / this.scale) return s.chosenDeviceId || null;
    this.lastDevicesAt = t;
    const devs = await this.spotify.getDevices();
    if (!devs.length) { this.setStatus('no_device'); return null; }
    const chosen = devs.find((d) => d.id === s.chosenDeviceId) || devs.find((d) => d.is_active) || devs[0];
    return chosen.id;
  }

  /** Clasico de fiestas anteriores para el relleno (si esta activado y hay). */
  classicFiller() {
    const s = this.s; const st = s.settings;
    if (!this.library || st.fillerMode !== 'classics' || !this.party.active) return null;
    const busy = new Set(s.queue.map((q) => q.trackId));
    if (s.nowPlaying) busy.add(s.nowPlaying.trackId);
    if (s.fed) busy.add(s.fed.trackId);
    const played = this.party.partyHistory().map((h) => h.trackId);
    let t = this.library.pickFiller({ minScore: st.classicsMinScore, exclude: new Set([...busy, ...played]) });
    if (!t) t = this.library.pickFiller({ minScore: st.classicsMinScore, exclude: new Set([...busy, ...played.slice(-15)]) });
    if (!t) return null;
    return {
      qid: `classic:${t.trackId}`, uri: t.uri, trackId: t.trackId, name: t.name, artists: t.artists,
      durationMs: t.durationMs || 0, addedBy: null, filler: 'classic', votes: [],
    };
  }

  async coldStart(pl) {
    const s = this.s;
    const item = this.party.nextToFeed() || this.classicFiller();
    if (!item) return;
    const deviceId = await this.chooseDevice(pl);
    if (!deviceId) return;
    await this.spotify.play({ uris: [item.uri], deviceId });
    s.pausedByUs = false;
    this.markFed(item);
    this.setStatus('ok');
    this.nudge(700 / this.scale);
  }

  // ---------- acciones ----------
  _guard() {
    if (!this.spotify.configured) throw new SpotifyError({ kind: 'not_configured' });
    if (!this.spotify.connected) throw new SpotifyError({ kind: 'disconnected' });
  }

  skip() {
    return this.lock.run(async () => {
      this._guard();
      const s = this.s;
      try {
        if (!s.fed) {
          const item = this.party.active ? (this.party.nextToFeed() || this.classicFiller()) : null;
          if (item) await this.feed(item);
        }
        await this.spotify.next();
      } catch (e) {
        if (e.kind !== 'restriction') { this.onError(e); throw e; }
      }
      if (s.nowPlaying) s.nowPlaying.skipped = true;
      s.pausedByUs = false;
      this.forceBroadcast = true;
      this.onChange(true);
      this.nudge(700 / this.scale);
    });
  }

  pause() {
    return this.lock.run(async () => {
      this._guard();
      const s = this.s;
      try { await this.spotify.pause(); } catch (e) {
        if (e.kind !== 'restriction') { this.onError(e); throw e; }
      }
      s.pausedByUs = true;
      const np = s.nowPlaying;
      if (np && np.isPlaying) { np.progressMs = Math.round(this.projected(np)); np.at = this.now(); np.isPlaying = false; }
      this.onChange(true);
      this.nudge(500 / this.scale);
    });
  }

  resume() {
    return this.lock.run(async () => {
      this._guard();
      const s = this.s;
      try { await this.spotify.play({}); } catch (e) {
        if (e.kind === 'restriction') { /* ya sonaba */ }
        else if (e.kind === 'no_device' || e.kind === 'not_found') {
          // El dispositivo se ha dormido (tipico en iPhone tras pausar): despertarlo transfiriendo con play
          const id = this.activeDeviceId || s.chosenDeviceId || s.player.deviceId;
          if (!id) { this.onError(e); throw e; }
          try { await this.spotify.play({ deviceId: id }); }
          catch (e2) {
            try { await this.spotify.transfer(id, true); }
            catch (e3) { this.onError(e3); throw e3; }
          }
        } else { this.onError(e); throw e; }
      }
      s.pausedByUs = false;
      const np = s.nowPlaying;
      if (np && !np.isPlaying) { np.at = this.now(); np.isPlaying = true; }
      this.onChange(true);
      this.nudge(500 / this.scale);
    });
  }

  setVolume(pct) {
    return this.lock.run(async () => {
      this._guard();
      if (this.s.player.supportsVolume === false) throw new SpotifyError({ kind: 'no_volume', message: 'El dispositivo no admite volumen' });
      const id = this.activeDeviceId || this.s.player.deviceId || this.s.chosenDeviceId;
      try { await this.spotify.setVolume(pct, id); } catch (e) {
        if (e.kind === 'forbidden' || /volume/i.test(e.message || '')) throw new SpotifyError({ kind: 'no_volume', status: e.status, message: e.message });
        if (e.kind === 'no_device' || e.kind === 'not_found') {
          try { await this.spotify.setVolume(pct); } catch (e2) { this.onError(e2); throw e2; }
        } else { this.onError(e); throw e; }
      }
      this.s.player.volume = Math.round(pct);
      this.onChange(true);
    });
  }

  selectDevice(deviceId) {
    return this.lock.run(async () => {
      this._guard();
      try { await this.spotify.transfer(deviceId, false); } catch (e) { this.onError(e); throw e; }
      this.s.chosenDeviceId = deviceId;
      this.s.player.deviceId = deviceId;
      this.party.dirty();
      this.onChange(true);
      this.nudge(500 / this.scale);
    });
  }
}
