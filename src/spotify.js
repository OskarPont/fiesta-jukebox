import { Mutex, sleep as realSleep } from './util.js';

const API = 'https://api.spotify.com/v1';
const ACCOUNTS = 'https://accounts.spotify.com';

export class SpotifyError extends Error {
  /**
   * kind: not_configured | disconnected | no_device | premium_required | rate_limited |
   *       restriction | forbidden | not_found | auth | network | server | bad_request | other
   */
  constructor({ status = 0, kind = 'other', reason = '', message = '', retryAfterMs = 0 }) {
    super(message || `Spotify ${status} ${reason}`);
    this.status = status; this.kind = kind; this.reason = reason; this.retryAfterMs = retryAfterMs;
  }
}

/** Texto en espanol para el usuario segun el tipo de error. */
export function friendlyError(e) {
  switch (e?.kind) {
    case 'rate_limited': return 'Spotify va saturado, prueba en unos segundos.';
    case 'no_device': return 'No hay ningún dispositivo de Spotify activo. Avisa al anfitrión.';
    case 'premium_required': return 'Spotify Premium es necesario para controlar la música.';
    case 'disconnected': return 'Spotify está desconectado. Avisa al anfitrión.';
    case 'not_configured': return 'Spotify no está configurado todavía.';
    case 'network': return 'No se pudo hablar con Spotify. Prueba otra vez.';
    case 'not_found': return 'El dispositivo de Spotify no responde. Abre Spotify en el altavoz de la fiesta.';
    case 'no_volume': return 'Este dispositivo no deja cambiar el volumen desde fuera (pasa con iPhone). Cámbialo en el propio dispositivo.';
    default: return 'Spotify no respondió bien. Prueba otra vez.';
  }
}

export function normTrack(t) {
  if (!t || !t.id || t.type === 'episode') return null;
  const imgs = [...(t.album?.images || [])].sort((a, b) => (b.width || 0) - (a.width || 0));
  const image = imgs[0]?.url || null;
  const thumb = [...imgs].reverse().find((i) => (i.width || 0) >= 150)?.url || image;
  return {
    uri: t.uri || `spotify:track:${t.id}`,
    trackId: t.id,
    name: String(t.name || ''),
    artists: (t.artists || []).map((a) => a.name).filter(Boolean),
    album: t.album?.name || '',
    image,
    thumb,
    durationMs: t.duration_ms || 0,
    explicit: !!t.explicit,
  };
}

export class Spotify {
  /**
   * @param {object} o
   * @param {import('./store.js').Store} o.store
   * @param {object} o.config
   * @param {Function} [o.http] compatible con fetch(url, init)
   */
  constructor({ store, config, http, now = Date.now, sleep = realSleep, mock = false, log = () => {} }) {
    this.store = store; this.config = config; this.now = now; this.sleep = sleep; this.mock = mock; this.log = log;
    this.http = http || ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15000) }));
    this.limitedUntil = 0;
    this.refreshing = null;
    this.mutex = new Mutex();
    this.disabled = new Set(); // funciones degradadas (por ejemplo 'playlists')
  }

  get creds() { return this.store.creds; }
  get tokens() { return this.store.tokens; }
  get configured() { return this.mock || !!(this.creds?.clientId && this.creds?.clientSecret); }
  get connected() { return !!this.tokens?.refreshToken; }
  get rateLimitedMs() { return Math.max(0, this.limitedUntil - this.now()); }

  // ---------- OAuth ----------
  authUrl(state) {
    const q = new URLSearchParams({
      client_id: this.creds.clientId, response_type: 'code', redirect_uri: this.config.REDIRECT_URI,
      scope: this.config.SCOPES, state, show_dialog: 'true',
    });
    return `${ACCOUNTS}/authorize?${q}`;
  }

  async _tokenRequest(params) {
    const clientId = this.creds?.clientId || 'mock';
    const secret = this.creds?.clientSecret || 'mock';
    let res;
    try {
      res = await this.http(`${ACCOUNTS}/api/token`, {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${clientId}:${secret}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(params).toString(),
      });
    } catch (e) {
      throw new SpotifyError({ kind: 'network', message: 'Sin conexión con Spotify: ' + e.message });
    }
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* ignorar */ }
    if (res.status === 429) {
      const ra = parseInt(res.headers.get('retry-after') || '5', 10);
      this.limitedUntil = this.now() + ra * 1000;
      throw new SpotifyError({ status: 429, kind: 'rate_limited', retryAfterMs: ra * 1000 });
    }
    if (!res.ok) {
      const err = body?.error;
      if (res.status === 400 && err === 'invalid_grant') {
        throw new SpotifyError({ status: 400, kind: 'auth', reason: 'invalid_grant', message: body?.error_description || 'invalid_grant' });
      }
      throw new SpotifyError({ status: res.status, kind: res.status >= 500 ? 'server' : 'auth', reason: String(err || ''), message: body?.error_description || `token ${res.status}` });
    }
    return body;
  }

  async exchangeCode(code) {
    const b = await this._tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: this.config.REDIRECT_URI });
    this.store.saveTokens({
      accessToken: b.access_token, expiresAt: this.now() + (b.expires_in || 3600) * 1000,
      refreshToken: b.refresh_token, authorizedAt: this.now(), userName: null,
    });
    try {
      const me = await this.me();
      this.store.saveTokens({ ...this.tokens, userName: me.display_name || me.id || null, product: me.product || null });
    } catch (e) { this.log('no se pudo leer /me', e.message); }
    return this.tokens;
  }

  /** Evita refrescos simultaneos. */
  refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const t = this.tokens;
      if (!t?.refreshToken) throw new SpotifyError({ kind: 'disconnected', message: 'Sin refresh token' });
      try {
        const b = await this._tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refreshToken });
        this.store.saveTokens({
          ...t, accessToken: b.access_token, expiresAt: this.now() + (b.expires_in || 3600) * 1000,
          refreshToken: b.refresh_token || t.refreshToken,
        });
      } catch (e) {
        if (e.reason === 'invalid_grant') {
          this.store.saveTokens({ ...t, accessToken: null, expiresAt: 0, refreshToken: null });
          throw new SpotifyError({ kind: 'disconnected', message: 'Spotify rechazó el refresh token (hay que reconectar)' });
        }
        throw e;
      } finally { this.refreshing = null; }
    })();
    return this.refreshing;
  }

  async ensureToken() {
    const t = this.tokens;
    if (!t?.refreshToken) throw new SpotifyError({ kind: 'disconnected', message: 'Spotify no está conectado' });
    if (!t.accessToken || t.expiresAt - this.now() < 60000) await this.refresh();
  }

  disconnect() { this.store.saveTokens(null); }
  /** Solo mock: conectar sin OAuth. */
  mockConnect() {
    this.store.saveTokens({ accessToken: 'mock-access-0', expiresAt: this.now() + 3600000, refreshToken: 'mock-refresh', authorizedAt: this.now(), userName: 'Anfitrión (mock)' });
  }

  // ---------- llamadas ----------
  _url(path, query) {
    const u = new URL(path.startsWith('http') ? path : API + path);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    return u.toString();
  }

  async _once(method, path, { query, body }) {
    let res;
    try {
      res = await this.http(this._url(path, query), {
        method,
        headers: {
          Authorization: `Bearer ${this.tokens.accessToken}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new SpotifyError({ kind: 'network', message: 'Sin conexión con Spotify: ' + e.message });
    }
    return res;
  }

  async call(method, path, opts = {}) {
    if (!this.configured) throw new SpotifyError({ kind: 'not_configured', message: 'Spotify sin configurar' });
    if (!this.connected) throw new SpotifyError({ kind: 'disconnected', message: 'Spotify desconectado' });
    const limited = this.rateLimitedMs;
    if (limited > 0) throw new SpotifyError({ status: 429, kind: 'rate_limited', retryAfterMs: limited, message: 'En espera por límite de Spotify' });
    await this.ensureToken();

    let res = await this._once(method, path, opts).catch((e) => e);
    if (res instanceof SpotifyError) {            // error de red: un reintento
      await this.sleep(500);
      res = await this._once(method, path, opts);
    }
    if (res.status === 401) {
      await this.refresh();
      res = await this._once(method, path, opts);
    } else if (res.status >= 500) {
      await this.sleep(500);
      res = await this._once(method, path, opts);
    }

    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }

    if (res.status === 429) {
      const ra = Math.max(1, parseInt(res.headers.get('retry-after') || '10', 10) || 10);
      this.limitedUntil = this.now() + ra * 1000;
      throw new SpotifyError({ status: 429, kind: 'rate_limited', reason: data?.error?.reason || '', retryAfterMs: ra * 1000, message: 'Spotify 429' });
    }
    if (res.ok) return data;           // 200, 201, 202, 204

    const err = data?.error;
    const reason = (typeof err === 'object' ? err?.reason : '') || '';
    const message = (typeof err === 'object' ? err?.message : err) || `HTTP ${res.status}`;
    let kind = 'other';
    if (res.status === 404 && /NO_ACTIVE_DEVICE/i.test(reason + message.replace(/ /g, '_'))) kind = 'no_device';
    else if (res.status === 404 && /no active device/i.test(message)) kind = 'no_device';
    else if (res.status === 403 && (/PREMIUM_REQUIRED/i.test(reason) || /premium/i.test(message))) kind = 'premium_required';
    else if (res.status === 403) kind = /restriction/i.test(message) ? 'restriction' : 'forbidden';
    else if (res.status === 404) kind = 'not_found';
    else if (res.status === 401) kind = 'auth';
    else if (res.status === 400) kind = 'bad_request';
    else if (res.status >= 500) kind = 'server';
    console.error(`[spotify] ${method} ${path} -> ${res.status} ${reason} ${message}`);
    throw new SpotifyError({ status: res.status, kind, reason, message });
  }

  /** Acciones de control serializadas. */
  control(fn) { return this.mutex.run(fn); }

  // ---------- API ----------
  me() { return this.call('GET', '/me'); }
  async getPlayer() {
    return (await this.call('GET', '/me/player', { query: { additional_types: 'track' } })) || null;
  }
  getQueue() { return this.call('GET', '/me/player/queue'); }
  async getDevices() { return (await this.call('GET', '/me/player/devices'))?.devices || []; }
  transfer(deviceId, play = false) {
    return this.control(() => this.call('PUT', '/me/player', { body: { device_ids: [deviceId], play } }));
  }
  play({ uris, deviceId } = {}) {
    return this.control(() => this.call('PUT', '/me/player/play', {
      query: deviceId ? { device_id: deviceId } : undefined,
      body: uris ? { uris } : undefined,
    }));
  }
  pause() { return this.control(() => this.call('PUT', '/me/player/pause')); }
  next() { return this.control(() => this.call('POST', '/me/player/next')); }
  addToQueue(uri, deviceId) {
    return this.control(() => this.call('POST', '/me/player/queue', { query: { uri, device_id: deviceId || undefined } }));
  }
  setVolume(pct, deviceId) {
    return this.control(() => this.call('PUT', '/me/player/volume', { query: { volume_percent: Math.round(pct), device_id: deviceId || undefined } }));
  }
  async search(q) {
    const r = await this.call('GET', '/search', { query: { q, type: 'track', limit: 10, market: process.env.SPOTIFY_MARKET || 'ES' } });
    return (r?.tracks?.items || []).map(normTrack).filter(Boolean);
  }

  /** Crea playlist privada con los uris dados. Devuelve {id, url, added}. */
  async createPlaylist(name, uris, description = 'Creada por fiesta.') {
    const body = { name, public: false, description };
    let pl;
    try {
      pl = await this.call('POST', '/me/playlists', { body });
    } catch (e) {
      if (e.status !== 404 && e.status !== 405) throw e;
      const me = await this.me();
      pl = await this.call('POST', `/users/${encodeURIComponent(me.id)}/playlists`, { body });
    }
    let useItems = true;
    for (let i = 0; i < uris.length; i += 100) {
      const chunk = uris.slice(i, i + 100);
      try {
        await this.call('POST', `/playlists/${pl.id}/${useItems ? 'items' : 'tracks'}`, { body: { uris: chunk } });
      } catch (e) {
        if (useItems && e.status === 404) {
          useItems = false;
          await this.call('POST', `/playlists/${pl.id}/tracks`, { body: { uris: chunk } });
        } else throw e;
      }
    }
    return { id: pl.id, url: pl.external_urls?.spotify || `https://open.spotify.com/playlist/${pl.id}`, added: uris.length };
  }
}
