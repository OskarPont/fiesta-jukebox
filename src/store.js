import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_SETTINGS = Object.freeze({
  pauseMode: 'direct',
  skipMode: 'vote',
  skipVoteMode: 'pct',
  skipVotePct: 50,
  skipVoteFixed: 3,
  maxQueuedPerGuest: 3,
  addCooldownSec: 15,
  controlCooldownSec: 20,
  globalControlCooldownSec: 8,
  ordering: 'votes',
  allowExplicit: true,
  maxDurationMin: 10,
  noRepeatMin: 60,
  allowAdd: true,
});

/**
 * Migracion de ajustes antiguos (skipVotePct + skipVoteMin) al modelo nuevo
 * (skipVoteMode + skipVotePct | skipVoteFixed). Se aplica una sola vez, al cargar
 * state.json, antes de que nadie lea los ajustes. Devuelve true si cambio algo.
 */
export function migrateSettings(st) {
  if (!st) return false;
  let changed = false;
  // #36: se quitaron los clasicos y el relleno por clasicos
  for (const k of ['fillerMode', 'classicsMinScore', 'classicsAutoUpdate']) {
    if (k in st) { delete st[k]; changed = true; }
  }
  if (st.skipVoteMin === undefined) return changed;
  if (st.skipVoteMode === undefined) {
    const min = Number(st.skipVoteMin);
    if (min <= 2) {
      st.skipVoteMode = 'pct';
      st.skipVotePct = Math.max(10, Number(st.skipVotePct) || DEFAULT_SETTINGS.skipVotePct);
    } else {
      st.skipVoteMode = 'fixed';
      st.skipVoteFixed = Math.min(20, min);
    }
  }
  delete st.skipVoteMin;
  return true;
}

export function defaultState() {
  return {
    settings: { ...DEFAULT_SETTINGS },
    party: null,
    guests: {},
    queue: [],
    nowPlaying: null,
    history: [],
    fed: null,
    pausedByUs: false,
    chosenDeviceId: null,
    lastGlobalControlAt: 0,
    player: { status: 'not_configured', deviceId: null, deviceName: null, volume: null },
    flags: {},
  };
}

export function writeJsonAtomic(file, obj, mode = 0o644) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode });
  try { fs.chmodSync(tmp, mode); } catch { /* ignorar */ }
  fs.renameSync(tmp, file);
}

/** Lee JSON. Si esta corrupto lo renombra y devuelve null. */
export function readJsonSafe(file, now = Date.now) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try {
    const d = JSON.parse(raw);
    if (d && typeof d === 'object') return d;
    throw new Error('no es un objeto');
  } catch {
    try { fs.renameSync(file, `${file}.corrupt-${now()}`); } catch { /* ignorar */ }
    return null;
  }
}

export class Store {
  constructor(dir, { now = Date.now, debounceMs = 1000 } = {}) {
    this.dir = dir; this.now = now; this.debounceMs = debounceMs;
    this.state = defaultState();
    this.tokens = null;       // spotify.json
    this.creds = null;        // config.json
    this.timer = null;
    fs.mkdirSync(dir, { recursive: true });
  }
  get file() { return path.join(this.dir, 'state.json'); }
  load() {
    const d = readJsonSafe(this.file, this.now);
    const base = defaultState();
    let migrated = false;
    if (d) {
      for (const k of Object.keys(base)) if (d[k] !== undefined) base[k] = d[k];
      const saved = { ...(d.settings || {}) };
      migrated = migrateSettings(saved);
      base.settings = { ...DEFAULT_SETTINGS, ...saved };
      if (!base.guests || typeof base.guests !== 'object' || Array.isArray(base.guests)) base.guests = {};
      if (!Array.isArray(base.queue)) base.queue = [];
      if (!Array.isArray(base.history)) base.history = [];
      base.player = { ...defaultState().player };
      base.flags = {};
    }
    Object.assign(this.state, base);
    if (migrated) this.save();   // persistir los ajustes ya migrados
    this.tokens = readJsonSafe(path.join(this.dir, 'spotify.json'), this.now);
    this.creds = readJsonSafe(path.join(this.dir, 'config.json'), this.now);
    return this;
  }
  /** Programa guardado con debounce. */
  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.debounceMs);
    this.timer.unref?.();
  }
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try { writeJsonAtomic(this.file, this.state); } catch (e) { console.error('[store] no se pudo guardar state.json', e.message); }
  }
  saveTokens(t) {
    this.tokens = t;
    const f = path.join(this.dir, 'spotify.json');
    try {
      if (t) writeJsonAtomic(f, t, 0o600); else fs.rmSync(f, { force: true });
    } catch (e) { console.error('[store] spotify.json', e.message); }
  }
  saveCreds(c) {
    this.creds = c;
    const f = path.join(this.dir, 'config.json');
    try {
      if (c) writeJsonAtomic(f, c, 0o600); else fs.rmSync(f, { force: true });
    } catch (e) { console.error('[store] config.json', e.message); }
  }
}
