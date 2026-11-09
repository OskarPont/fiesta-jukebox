/**
 * Simulador de Spotify (SPOTIFY_MOCK=1). Sustituye solo la capa HTTP: devuelve
 * objetos compatibles con fetch Response para que spotify.js se use tal cual.
 */

const ADJ = ['Neón', 'Cobalto', 'Salvaje', 'Lento', 'Dorado', 'Tropical', 'Eléctrico', 'Suave', 'Nocturno', 'Rápido', 'Azul', 'Brillante', 'Cálido', 'Lejano', 'Loco', 'Dulce'];
const NOUN = ['Mareas', 'Verano', 'Ciudad', 'Fuego', 'Sueños', 'Domingo', 'Cometa', 'Selva', 'Espejo', 'Carretera', 'Luna', 'Terraza', 'Playa', 'Tormenta', 'Radio', 'Jardín'];
const ARTISTS = ['Luna Cobalto', 'Los Faroles', 'Mara Quintana', 'DJ Pixelado', 'Nube Siete', 'Hermanos Tropicales', 'Vera Lumen', 'Kiko Sintético', 'La Orquesta Mínima', 'Sol de Medianoche'];
const COLORS = [['#ff3d8b', '#7b2cff'], ['#c6ff3d', '#00b894'], ['#ffb02e', '#ff3d00'], ['#3dc8ff', '#2d3bff'], ['#ff6b6b', '#4d0f3b'], ['#9b5cff', '#101040']];

function svgCover(i, label) {
  const [a, b] = COLORS[i % COLORS.length];
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='${a}'/><stop offset='1' stop-color='${b}'/></linearGradient></defs><rect width='100' height='100' fill='url(#g)'/><circle cx='${30 + (i * 7) % 40}' cy='${35 + (i * 11) % 30}' r='${18 + (i % 5) * 4}' fill='rgba(255,255,255,.18)'/><text x='50' y='62' font-size='34' font-family='sans-serif' font-weight='700' text-anchor='middle' fill='rgba(255,255,255,.85)'>${label}</text></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

function mkId(i) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = 'Mk';
  let n = (i + 1) * 7919;
  while (s.length < 22) { s += chars[n % chars.length]; n = Math.floor(n / 3) + 17 * (s.length + i); }
  return s.slice(0, 22);
}

export function buildCatalog() {
  const out = [];
  for (let i = 0; i < 40; i++) {
    const name = `${NOUN[i % NOUN.length]} ${ADJ[(i * 5 + 3 + Math.floor(i / 16)) % ADJ.length]}`;
    const artist = ARTISTS[i % ARTISTS.length];
    const id = mkId(i);
    const img = svgCover(i, name[0]);
    out.push({
      id, uri: `spotify:track:${id}`, type: 'track', name,
      artists: [{ name: artist }],
      album: { name: `Álbum ${i % 7 + 1}`, images: [{ url: img, width: 640 }, { url: img, width: 300 }, { url: img, width: 64 }] },
      duration_ms: (120 + ((i * 37) % 121)) * 1000,
      explicit: i % 9 === 4,
    });
  }
  // una cancion larguisima para probar el limite de duracion
  const id = mkId(99);
  out.push({ id, uri: `spotify:track:${id}`, type: 'track', name: 'Maratón Infinito', artists: [{ name: 'Nube Siete' }],
    album: { name: 'Sesiones largas', images: [{ url: svgCover(3, 'M'), width: 640 }, { url: svgCover(3, 'M'), width: 300 }, { url: svgCover(3, 'M'), width: 64 }] },
    duration_ms: 13 * 60 * 1000, explicit: false });
  return out;
}

class Resp {
  constructor(status, body, headers = {}) {
    this.status = status; this._body = body;
    this.ok = status >= 200 && status < 300;
    const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
    this.headers = { get: (k) => h[String(k).toLowerCase()] ?? null };
  }
  async text() { return this._body == null ? '' : typeof this._body === 'string' ? this._body : JSON.stringify(this._body); }
  async json() { return JSON.parse(await this.text()); }
}
const err = (status, message, reason) => new Resp(status, { error: { status, message, ...(reason ? { reason } : {}) } });

export function createMock({ now = Date.now, speed = 1 } = {}) {
  const catalog = buildCatalog();
  const byId = new Map(catalog.map((t) => [t.id, t]));
  const S = {
    speed,
    deviceConnected: true,
    active: false,
    devices: [{ id: 'mockdev1', name: 'Altavoz salón', type: 'Speaker', volume_percent: 60 }],
    current: null, playing: false, progressMs: 0, ts: now(),
    queue: [], filler: [], fillerIdx: 0, hasFiller: false,
    limitedUntil: 0, accessToken: 'mock-access-0', tokenN: 0, refreshValid: true,
    playlists: [], calls: [], tokenCalls: 0,
  };

  function startNext(leftoverMs = 0) {
    let next = null;
    if (S.queue.length) next = S.queue.shift();
    else if (S.hasFiller && S.filler.length) next = S.filler[S.fillerIdx++ % S.filler.length];
    if (!next) { S.playing = false; S.progressMs = 0; return false; }
    S.current = next; S.progressMs = leftoverMs; S.playing = true;
    return true;
  }
  function advance() {
    const t = now();
    if (S.playing && S.current) {
      S.progressMs += (t - S.ts) * S.speed;
      let guard = 50;
      while (S.playing && S.current && S.progressMs >= S.current.duration_ms && guard--) {
        const left = S.progressMs - S.current.duration_ms;
        if (!startNext(left)) break;
      }
    }
    S.ts = t;
  }
  const device = () => ({ ...S.devices[0], is_active: true, is_restricted: false, supports_volume: true });
  const playerBody = () => ({
    device: device(), repeat_state: 'off', shuffle_state: false,
    is_playing: S.playing, progress_ms: Math.floor(S.progressMs), item: S.current,
    currently_playing_type: S.current ? 'track' : 'unknown', actions: {},
  });
  const noDevice = () => err(404, 'Player command failed: No active device found', 'NO_ACTIVE_DEVICE');
  const needDevice = () => (!S.deviceConnected ? noDevice() : null);

  async function http(url, init = {}) {
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    let body = init.body;

    // ----- cuentas -----
    if (u.hostname === 'accounts.spotify.com' && u.pathname === '/api/token') {
      S.tokenCalls++;
      const p = new URLSearchParams(String(body || ''));
      const grant = p.get('grant_type');
      if (grant === 'authorization_code') {
        if (p.get('code') !== 'mock-code') return new Resp(400, { error: 'invalid_grant', error_description: 'Invalid authorization code' });
      } else if (grant === 'refresh_token') {
        if (!S.refreshValid || p.get('refresh_token') !== 'mock-refresh') return new Resp(400, { error: 'invalid_grant', error_description: 'Refresh token revoked' });
      } else return new Resp(400, { error: 'unsupported_grant_type' });
      S.accessToken = `mock-access-${++S.tokenN}`;
      return new Resp(200, { access_token: S.accessToken, token_type: 'Bearer', expires_in: S.expiresIn || 3600, refresh_token: grant === 'authorization_code' ? 'mock-refresh' : undefined, scope: '' });
    }

    // ----- API -----
    if (u.hostname !== 'api.spotify.com') return err(404, 'host desconocido');
    const path = u.pathname.replace(/^\/v1/, '');
    S.calls.push(`${method} ${path}${u.search}`);
    if (headers.authorization !== `Bearer ${S.accessToken}`) return err(401, 'The access token expired');
    if (S.limitedUntil > now()) {
      return new Resp(429, { error: { status: 429, message: 'API rate limit exceeded', reason: 'QUOTA_EXCEEDED' } }, { 'Retry-After': Math.max(1, Math.ceil((S.limitedUntil - now()) / 1000)) });
    }
    if (S.failNext > 0) { S.failNext--; return err(503, 'Service unavailable'); }
    if (typeof body === 'string' && body) { try { body = JSON.parse(body); } catch { /* ignorar */ } }
    const q = u.searchParams;
    advance();

    if (method === 'GET' && path === '/me') return new Resp(200, { id: 'mockuser', display_name: 'Anfitrión (mock)', product: 'premium' });

    if (method === 'GET' && path === '/me/player') {
      if (!S.deviceConnected || !S.active) return new Resp(204, '');
      return new Resp(200, playerBody());
    }
    if (method === 'GET' && path === '/me/player/queue') {
      if (!S.deviceConnected || !S.active) return new Resp(200, { currently_playing: null, queue: [] });
      return new Resp(200, { currently_playing: S.current, queue: [...S.queue] });
    }
    if (method === 'GET' && path === '/me/player/devices') {
      return new Resp(200, { devices: S.deviceConnected ? [{ ...S.devices[0], is_active: S.active }] : [] });
    }
    if (method === 'PUT' && path === '/me/player') {
      const d = needDevice(); if (d) return d;
      if (!body?.device_ids?.includes(S.devices[0].id)) return err(404, 'Device not found');
      S.active = true;
      if (body.play === true && S.current) S.playing = true;
      return new Resp(204, '');
    }
    if (method === 'PUT' && path === '/me/player/play') {
      const d = needDevice(); if (d) return d;
      if (body?.uris?.length) {
        const tracks = body.uris.map((x) => byId.get(String(x).split(':').pop()));
        if (tracks.some((x) => !x)) return err(400, 'Invalid track uri');
        S.active = true; S.current = tracks[0]; S.progressMs = 0; S.playing = true;
        S.filler = tracks.slice(1); S.fillerIdx = 0; S.hasFiller = S.filler.length > 0;
        return new Resp(204, '');
      }
      if (!S.active && !S.current) return noDevice();
      if (S.playing) return err(403, 'Player command failed: Restriction violated', 'UNKNOWN');
      if (!S.current) { if (!startNext()) return err(404, 'No track to play'); } else S.playing = true;
      S.active = true;
      return new Resp(204, '');
    }
    if (method === 'PUT' && path === '/me/player/pause') {
      const d = needDevice(); if (d) return d;
      if (!S.active) return noDevice();
      if (!S.playing) return err(403, 'Player command failed: Restriction violated', 'UNKNOWN');
      S.playing = false;
      return new Resp(204, '');
    }
    if (method === 'POST' && path === '/me/player/next') {
      const d = needDevice(); if (d) return d;
      if (!S.active) return noDevice();
      startNext(0);
      return new Resp(204, '');
    }
    if (method === 'POST' && path === '/me/player/queue') {
      const d = needDevice(); if (d) return d;
      if (!S.active) return noDevice();
      const tr = byId.get(String(q.get('uri') || '').split(':').pop());
      if (!tr) return err(400, 'Invalid track uri');
      S.queue.push(tr);
      return new Resp(204, '');
    }
    if (method === 'PUT' && path === '/me/player/volume') {
      const d = needDevice(); if (d) return d;
      S.devices[0].volume_percent = Math.max(0, Math.min(100, parseInt(q.get('volume_percent'), 10) || 0));
      return new Resp(204, '');
    }
    if (method === 'GET' && path === '/search') {
      const lim = parseInt(q.get('limit') || '20', 10);
      if (lim > 10) return err(400, 'Invalid limit');
      const term = (q.get('q') || '').toLowerCase();
      const items = catalog.filter((t) => `${t.name} ${t.artists[0].name}`.toLowerCase().includes(term)).slice(0, lim);
      return new Resp(200, { tracks: { items, total: items.length, limit: lim } });
    }
    if (method === 'POST' && (path === '/me/playlists' || path === '/users/mockuser/playlists')) {
      const pl = { id: 'pl' + (S.playlists.length + 1), name: body?.name, public: body?.public, uris: [] };
      S.playlists.push(pl);
      return new Resp(201, { id: pl.id, external_urls: { spotify: `https://open.spotify.com/playlist/${pl.id}` } });
    }
    const m = /^\/playlists\/([^/]+)\/(items|tracks)$/.exec(path);
    if (method === 'POST' && m) {
      if (S.playlistsItemsAs404 && m[2] === 'items') return err(404, 'Not found');
      const pl = S.playlists.find((p) => p.id === m[1]);
      if (!pl) return err(404, 'Playlist not found');
      if (!Array.isArray(body?.uris) || body.uris.length > 100) return err(400, 'Too many uris');
      pl.uris.push(...body.uris);
      return new Resp(201, { snapshot_id: 'snap' });
    }
    if (method === 'PUT' && m) {
      if (S.playlistsItemsAs404 && m[2] === 'items') return err(404, 'Not found');
      const pl = S.playlists.find((p) => p.id === m[1]);
      if (!pl) return err(404, 'Playlist not found');
      pl.uris = [...(body?.uris || [])];
      return new Resp(200, { snapshot_id: 'snap' });
    }
    return err(404, `mock: endpoint no soportado ${method} ${path}`);
  }

  /** Controles de prueba. */
  const ctl = {
    state: S,
    setSpeed(x) { advance(); S.speed = Math.max(0.1, Number(x) || 1); },
    disconnectDevice() { advance(); S.deviceConnected = false; S.active = false; S.playing = false; },
    connectDevice() { S.deviceConnected = true; },
    rateLimit(sec) { S.limitedUntil = now() + sec * 1000; },
    failNext(n = 1) { S.failNext = n; },
    expireAccessToken() { S.accessToken = 'mock-access-expired-' + (++S.tokenN); },
    revokeRefresh() { S.refreshValid = false; },
    items404() { S.playlistsItemsAs404 = true; },
    /** Empieza a sonar una "playlist del anfitrion" de relleno. */
    startFiller(n = 5, offset = 20) {
      advance();
      S.filler = catalog.slice(offset, offset + n); S.fillerIdx = 0; S.hasFiller = true;
      S.active = true; S.deviceConnected = true;
      S.current = S.filler[S.fillerIdx++ % S.filler.length]; S.progressMs = 0; S.playing = true;
    },
    snapshot() { advance(); return { current: S.current?.name || null, playing: S.playing, progressMs: Math.floor(S.progressMs), queue: S.queue.map((t) => t.name), speed: S.speed, deviceConnected: S.deviceConnected, volume: S.devices[0].volume_percent, playlists: S.playlists, calls: S.calls.length }; },
    catalog, byId,
  };
  return { http, ctl };
}
