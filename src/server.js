import { isIphone } from './engine.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import QRCode from 'qrcode';

import { config, assertConfig } from './config.js';
import { Store } from './store.js';
import { Library, selectForPlaylist, summarize } from './library.js';
import { Party, PartyError } from './party.js';
import { Spotify, SpotifyError, friendlyError } from './spotify.js';
import { createMock } from './spotify-mock.js';
import { Engine } from './engine.js';
import { Hub, securityHeaders, buildCommon, adminHist } from './sse.js';
import {
  ADMIN_COOKIE, GUEST_COOKIE, GUEST_TTL_S, makeAdminCookie, verifyAdminCookie,
  createLimiters, cookieOpts, originAllowed,
} from './auth.js';
import { normQuery, LRU, randToken, safeEqual } from './util.js';

export async function createApp(cfg = config, { logger = false } = {}) {
  const store = new Store(cfg.DATA_DIR).load();
  const party = new Party({ state: store.state, onDirty: () => store.save() });
  const library = new Library(cfg.DATA_DIR).load();
  const limiters = createLimiters();
  const searchCache = new LRU(300, 10 * 60 * 1000);

  let mock = null;
  let http;
  if (cfg.MOCK) { mock = createMock({ speed: cfg.MOCK_SPEED }); http = mock.http; }
  const spotify = new Spotify({ store, config: cfg, http, mock: cfg.MOCK, log: (...a) => app.log.warn(a.join(' ')) });

  const ctx = { store, party, spotify, config: cfg, engine: null, library };
  const hub = new Hub({ ctx, hbMs: cfg.HB_MS });
  const engine = new Engine({
    store, party, spotify, library,
    onChange: (force) => hub.changed(force),
    toast: (t, k, by) => hub.toast(t, k, by),
    hasClients: () => hub.hasClients(),
    getScale: () => (mock ? mock.ctl.state.speed : 1),
    feedLeadMs: cfg.FEED_LEAD_MS,
    log: (...a) => app.log.info(a.join(' ')),
  });
  ctx.engine = engine;
  const s = store.state;

  const app = Fastify({
    logger: logger ? { level: process.env.LOG_LEVEL || 'warn' } : false,
    // Solo se confia en X-Forwarded-For si viene de un proxy de la lista (por defecto, redes privadas):
    // con `true` cualquiera podria falsear su IP y saltarse los limites de PIN y de login.
    trustProxy: cfg.TRUST_PROXY,
    bodyLimit: 16 * 1024,
  });
  await app.register(fastifyCookie);

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (!body || !body.trim()) return done(null, {});
    try { done(null, JSON.parse(body)); } catch { const e = new Error('JSON no válido'); e.statusCode = 400; done(e); }
  });

  const API = `${cfg.BASE_PATH}/api`;
  const secHeaders = securityHeaders();

  app.addHook('onRequest', async (req, reply) => {
    for (const [k, v] of Object.entries(secHeaders)) reply.header(k, v);
    if (req.url.startsWith(API)) reply.header('Cache-Control', 'no-store');
    const m = req.method;
    if (m === 'POST' || m === 'PUT' || m === 'DELETE') {
      if (!originAllowed(cfg, req.headers.origin)) {
        return reply.code(403).send({ error: 'bad_origin', message: 'Origen no permitido.' });
      }
      if (m !== 'DELETE' && !/^application\/json/i.test(req.headers['content-type'] || '')) {
        return reply.code(415).send({ error: 'bad_content_type', message: 'Se esperaba JSON.' });
      }
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof PartyError) {
      return reply.code(err.status).send({ error: err.code, message: err.message, ...err.data });
    }
    if (err instanceof SpotifyError) {
      const st = err.kind === 'rate_limited' ? 429 : (err.kind === 'premium_required' || err.kind === 'no_volume') ? 403 : 503;
      req.log.warn({ kind: err.kind, status: err.status, msg: err.message }, 'spotify error');
      const body = { error: 'spotify_' + err.kind, message: friendlyError(err) };
      if (err.retryAfterMs) body.retryInSec = Math.ceil(err.retryAfterMs / 1000);
      return reply.code(st).send(body);
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: 'bad_request', message: err.statusCode === 400 ? 'Petición no válida.' : 'No se pudo procesar la petición.' });
    }
    req.log.error(err);
    return reply.code(500).send({ error: 'server_error', message: 'Algo ha fallado. Prueba otra vez.' });
  });

  const fail = (status, error, message) => { throw new PartyError(status, error, message); };
  const isAdmin = (req) => verifyAdminCookie(cfg.COOKIE_SECRET, req.cookies[ADMIN_COOKIE]);
  const guestOf = (req) => party.getGuest(req.cookies[GUEST_COOKIE]);
  function needGuest(req) {
    const g = guestOf(req);
    if (!g) {
      if (party.isBanned(req.cookies[GUEST_COOKIE])) fail(403, 'banned', 'No puedes entrar a esta fiesta.');
      fail(401, 'no_session', 'Entra con el PIN de la fiesta.');
    }
    party.touch(g);
    return g;
  }
  function needAdmin(req) { if (!isAdmin(req)) fail(401, 'admin_required', 'Entra con la clave de administrador.'); }
  function rate(kind, key) {
    if (!limiters[kind].take(key)) fail(429, 'slow_down', 'Vas muy rápido, espera un segundo.');
  }
  const changed = (force = true) => hub.changed(force);

  /** Guarda la fiesta (activa o recien terminada) en la biblioteca. */
  function archiveCurrent() {
    if (!s.party) return;
    const joined = Math.max(s.party.joined || 0, Object.values(s.guests).filter((g) => g.partyId === s.party.id).length);
    library.archiveParty({ ...s.party, joined }, s.history);
    if (!s.party.active) s.party.archived = true;
    store.save();
  }

  /** Crea o actualiza la playlist "Clasicos de fiesta" en Spotify. */
  let classicsBusy = null;
  function updateClassics() {
    if (classicsBusy) return classicsBusy;
    classicsBusy = (async () => {
      if (!spotify.connected) throw new PartyError(409, 'disconnected', 'Conecta Spotify primero.');
      const list = library.classics({ minScore: s.settings.classicsMinScore, limit: 100 });
      if (!list.length) throw new PartyError(409, 'empty', 'Todavía no hay clásicos: hacen falta canciones con likes en tus fiestas.');
      const uris = list.map((t) => t.uri);
      const cur = library.data.classics;
      let ok = false;
      if (cur.playlistId) ok = await spotify.replacePlaylist(cur.playlistId, uris);
      if (ok) {
        library.setClassicsPlaylist({ updatedAt: Date.now(), count: uris.length });
      } else {
        const r = await spotify.createPlaylist('Clásicos de fiesta', uris, 'Las canciones que más gustan en mis fiestas. Se actualiza sola con fiesta.');
        library.setClassicsPlaylist({ playlistId: r.id, url: r.url, updatedAt: Date.now(), count: uris.length });
      }
      return { ...library.data.classics };
    })().finally(() => { classicsBusy = null; });
    return classicsBusy;
  }

  // ================= API =================
  await app.register(async (api) => {
    api.get('/health', async () => ({ ok: true }));

    api.get('/party', async () => ({ active: party.active, name: s.party?.name || null, needsPin: true }));

    api.post('/join', async (req, reply) => {
      const ip = req.ip;
      if (!limiters.joinAll.allowed(ip) || !limiters.joinFail.allowed(ip)) fail(429, 'too_many', 'Demasiados intentos. Espera un minuto.');
      limiters.joinAll.hit(ip);
      const { pin, name } = req.body || {};
      try {
        const r = party.join({ pin: typeof pin === 'string' ? pin : String(pin ?? ''), name, token: req.cookies[GUEST_COOKIE] });
        reply.setCookie(GUEST_COOKIE, r.token, cookieOpts(cfg, { maxAgeS: GUEST_TTL_S }));
        if (r.created) hub.toast(`${r.guest.name} se ha unido`, 'join');
        changed();
        return { guest: { id: r.guest.id, name: r.guest.name } };
      } catch (e) {
        if (e.code === 'bad_pin') limiters.joinFail.hit(ip);
        if (e.code === 'join_blocked') changed();
        throw e;
      }
    });

    api.get('/me', async (req) => {
      const g = needGuest(req);
      return { guest: { id: g.id, name: g.name }, party: { name: s.party.name } };
    });

    api.get('/events', async (req, reply) => {
      // La app de invitados pide ?view=guest: asi el anfitrion puede usarla en el mismo navegador que el panel.
      const asGuest = req.query?.view === 'guest';
      const admin = !asGuest && isAdmin(req);
      const guestToken = req.cookies[GUEST_COOKIE];
      if (!admin && !party.getGuest(guestToken)) fail(401, 'no_session', 'Entra con el PIN de la fiesta.');
      hub.add(req, reply, { isAdmin: admin, guestToken: admin ? null : guestToken }, secHeaders);
    });

    // ----- busqueda y cola -----
    api.get('/search', async (req) => {
      const admin = isAdmin(req);
      const g = admin ? null : needGuest(req);
      rate('search', g ? g.id : 'admin');
      const q = normQuery(req.query?.q);
      if (q.length < 2) return { results: [] };
      if (q.length > 100) fail(400, 'bad_query', 'Búsqueda demasiado larga.');
      let list = searchCache.get(q);
      if (!list) {
        list = await spotify.search(q);
        searchCache.set(q, list);
      }
      party.rememberTracks(list);
      return {
        results: list.map((t) => ({ ...t, ...party.annotate(t, g) })),
      };
    });

    api.post('/queue', async (req) => {
      const g = needGuest(req);
      rate('action', g.id);
      const item = party.addTrack(g, req.body?.uri);
      hub.toast(`${g.name} añadió ${item.name}`, 'add', g.id);
      changed(); engine.poke();
      const position = party.orderedQueue().findIndex((i) => i.qid === item.qid) + 1;
      return { item: { qid: item.qid, name: item.name }, position };
    });

    api.delete('/queue/:qid', async (req) => {
      const g = needGuest(req);
      rate('action', g.id);
      party.removeTrack(req.params.qid, g);
      changed();
      return { ok: true };
    });

    api.post('/queue/:qid/vote', async (req) => {
      const g = needGuest(req); rate('action', g.id);
      party.vote(g, req.params.qid, true); changed();
      return { ok: true };
    });
    api.delete('/queue/:qid/vote', async (req) => {
      const g = needGuest(req); rate('action', g.id);
      party.vote(g, req.params.qid, false); changed();
      return { ok: true };
    });

    // ----- like a la que suena -----
    api.post('/nowplaying/like', async (req) => {
      const g = needGuest(req); rate('action', g.id);
      const r = party.likeNow(g, true); changed();
      return r;
    });
    api.delete('/nowplaying/like', async (req) => {
      const g = needGuest(req); rate('action', g.id);
      const r = party.likeNow(g, false); changed();
      return r;
    });

    // ----- control -----
    async function direct(g, fn, text, pauseToggle = false) {
      const prev = { own: g.lastControlAt, glob: s.lastGlobalControlAt };
      if (pauseToggle) {
        // pausar/reanudar: solo un antirrebote global corto, sin cooldown por persona
        const wait = s.lastGlobalControlAt + 3000 - Date.now();
        if (wait > 0) fail(429, 'cooldown', `Alguien acaba de usar los controles. Espera ${Math.ceil(wait / 1000)} s.`);
      } else party.checkDirectControl(g);
      party.markControl(g);
      try { await fn(); } catch (e) { g.lastControlAt = prev.own; s.lastGlobalControlAt = prev.glob; throw e; }
      hub.toast(text, 'control');
      changed();
    }
    api.post('/control/pause', async (req) => {
      const g = needGuest(req); rate('action', g.id);
      if (s.settings.pauseMode === 'admin') fail(403, 'admin_only', 'Solo el anfitrión puede pausar.');
      if (s.player.isIphone) fail(403, 'iphone', 'Con la música en un iPhone solo el anfitrión puede pausar.');
      await direct(g, () => engine.pause(), `${g.name} pausó la música`, true);
      return { ok: true };
    });
    api.post('/control/resume', async (req) => {
      const g = needGuest(req); rate('action', g.id);
      if (s.settings.pauseMode === 'admin') fail(403, 'admin_only', 'Solo el anfitrión puede reanudar.');
      if (s.player.isIphone) fail(403, 'iphone', 'Con la música en un iPhone solo el anfitrión puede pausar.');
      await direct(g, () => engine.resume(), `${g.name} reanudó la música`, true);
      return { ok: true };
    });
    api.post('/control/skip', async (req) => {
      const g = needGuest(req); rate('action', g.id);
      const mode = s.settings.skipMode;
      if (mode === 'admin') fail(403, 'admin_only', 'Solo el anfitrión puede saltar canciones.');
      if (mode === 'direct') {
        await direct(g, () => engine.skip(), `${g.name} saltó la canción`);
        return { skipped: true };
      }
      const r = party.skipVote(g, true);
      if (r.reached) {
        try { await engine.skip(); } catch (e) { if (s.nowPlaying) s.nowPlaying.skipped = false; throw e; }
        hub.toast('¡Se salta por votación!', 'skip');
        changed();
        return { skipped: true, votes: r.votes, needed: r.needed };
      }
      changed();
      return { skipped: false, votes: r.votes, needed: r.needed, voted: r.voted };
    });
    api.delete('/control/skip', async (req) => {
      const g = needGuest(req); rate('action', g.id);
      const r = party.skipVote(g, false);
      changed();
      return { skipped: false, votes: r.votes, needed: r.needed, voted: r.voted };
    });

    // ================= ADMIN =================
    api.post('/admin/login', async (req, reply) => {
      const ip = req.ip;
      if (!limiters.adminLogin.allowed(ip)) fail(429, 'too_many', 'Demasiados intentos. Espera un minuto.');
      limiters.adminLogin.hit(ip);
      const key = req.body?.key;
      if (typeof key !== 'string' || !cfg.ADMIN_KEY || !safeEqual(key, cfg.ADMIN_KEY)) fail(403, 'bad_key', 'Clave incorrecta.');
      reply.setCookie(ADMIN_COOKIE, makeAdminCookie(cfg.COOKIE_SECRET), cookieOpts(cfg, { maxAgeS: 30 * 24 * 3600 }));
      return { ok: true };
    });
    api.post('/admin/logout', async (req, reply) => {
      reply.clearCookie(ADMIN_COOKIE, cookieOpts(cfg));
      return { ok: true };
    });

    await api.register(async (adm) => {
      adm.addHook('preHandler', async (req) => needAdmin(req));

      adm.get('/status', async () => ({ ok: true, ...buildCommon(ctx).admin, party: s.party, player: s.player, settings: s.settings }));

      adm.post('/spotify/credentials', async (req) => {
        const { clientId, clientSecret } = req.body || {};
        const ok = (v) => typeof v === 'string' && /^[A-Za-z0-9]{16,64}$/.test(v.trim());
        if (!ok(clientId) || !ok(clientSecret)) fail(400, 'bad_credentials', 'El Client ID y el Client Secret son cadenas de letras y números (32 caracteres). Cópialos tal cual.');
        const changedId = store.creds?.clientId !== clientId.trim();
        store.saveCreds({ clientId: clientId.trim(), clientSecret: clientSecret.trim() });
        if (changedId && spotify.connected) spotify.disconnect();
        engine.nudge(100);
        changed();
        return { ok: true };
      });

      adm.post('/spotify/disconnect', async () => {
        spotify.disconnect();
        s.player.status = 'disconnected';
        changed();
        return { ok: true };
      });

      adm.get('/devices', async () => {
        const devices = await spotify.getDevices();
        return { devices: devices.map((d) => ({ id: d.id, name: d.name, type: d.type, active: !!d.is_active, volume: d.volume_percent, isIphone: isIphone(d) })), chosenDeviceId: s.chosenDeviceId };
      });
      adm.post('/device', async (req) => {
        const id = req.body?.deviceId;
        if (typeof id !== 'string' || !id || id.length > 100) fail(400, 'bad_request', 'Dispositivo no válido.');
        await engine.selectDevice(id);
        try {
          const d = (await spotify.getDevices()).find((x) => x.id === id);
          if (d) { s.player.isIphone = isIphone(d); s.player.supportsVolume = d.supports_volume !== false; s.player.deviceName = d.name; changed(); }
        } catch { /* no pasa nada */ }
        return { ok: true };
      });

      adm.post('/party/start', async (req) => {
        if (s.party && !s.party.archived) { archiveCurrent(); }
        party.startParty(req.body?.name);
        s.showSummary = false;
        searchCache.map?.clear();
        engine.nudge(100);
        changed();
        return { party: s.party };
      });
      adm.post('/party/stop', async (req) => {
        const kickAll = req.body?.kickAll !== false;
        const joinedNow = s.party ? Object.values(s.guests).filter((g) => g.partyId === s.party.id).length : 0;
        party.stopParty({ kickAll });
        if (s.party) s.party.joined = Math.max(s.party.joined || 0, joinedNow);
        archiveCurrent();
        changed();
        if (s.settings.classicsAutoUpdate) updateClassics().catch((e) => app.log.warn('clasicos: ' + e.message));
        if (kickAll) setTimeout(() => hub.drop(() => true), 800);
        return { ok: true };
      });
      adm.post('/party/pin', async (req) => {
        const kickAll = req.body?.kickAll === true;
        const pin = party.regenPin({ kickAll });
        if (kickAll) hub.drop((c) => !party.getGuest(c.guestToken));
        changed();
        return { pin };
      });
      adm.post('/party/rename', async (req) => {
        party.renameParty(req.body?.name); changed();
        return { ok: true };
      });

      adm.put('/settings', async (req) => {
        const r = party.updateSettings(req.body);
        changed(); engine.poke();
        return { settings: r };
      });

      for (const act of ['pause', 'resume', 'skip']) {
        adm.post(`/control/${act}`, async () => {
          await engine[act]();
          hub.toast(act === 'skip' ? 'El anfitrión saltó la canción' : act === 'pause' ? 'El anfitrión pausó la música' : 'El anfitrión reanudó la música', 'control');
          changed();
          return { ok: true };
        });
      }
      adm.post('/volume', async (req) => {
        const pct = req.body?.pct;
        if (typeof pct !== 'number' || !(pct >= 0 && pct <= 100)) fail(400, 'bad_request', 'Volumen entre 0 y 100.');
        await engine.setVolume(pct);
        return { ok: true };
      });

      adm.post('/queue/:qid/top', async (req) => { party.adminTop(req.params.qid); changed(); return { ok: true }; });
      adm.post('/queue/reorder', async (req) => { party.adminReorder(req.body?.qids); changed(); return { ok: true }; });
      adm.delete('/queue/:qid', async (req) => { party.removeTrack(req.params.qid, null); changed(); return { ok: true }; });
      adm.post('/queue/clear', async () => { party.clearQueue(); changed(); return { ok: true }; });

      adm.post('/guests/:id/kick', async (req) => {
        const g = party.kick(req.params.id);
        hub.drop((c) => c.guestId === g.id);
        changed();
        return { ok: true };
      });
      adm.post('/guests/:id/ban', async (req) => {
        const g = party.ban(req.params.id);
        hub.drop((c) => c.guestId === g.id);
        changed();
        return { ok: true };
      });

      // ----- historial, playlists, resumen y clasicos -----
      function historyFor(partyId) {
        if (!partyId || partyId === 'current') {
          if (s.party?.active) return { party: s.party, history: party.partyHistory() };
          const last = library.data.parties[0];
          if (!last) fail(404, 'no_party', 'Todavía no hay ninguna fiesta.');
          return { party: last, history: last.history };
        }
        const p = library.getParty(String(partyId));
        if (!p) {
          if (s.party?.id === partyId) return { party: s.party, history: party.partyHistory() };
          fail(404, 'not_found', 'No encuentro esa fiesta.');
        }
        return { party: p, history: p.history };
      }
      function playlistOpts(b = {}) {
        const likeType = ['total', 'play', 'queue'].includes(b.likeType) ? b.likeType : 'total';
        const order = ['likes_desc', 'likes_asc', 'played_asc', 'played_desc', 'added_asc', 'added_desc'].includes(b.order) ? b.order : 'played_asc';
        const minLikes = Number.isInteger(b.minLikes) && b.minLikes >= 0 && b.minLikes <= 1000 ? b.minLikes : 0;
        return { likeType, order, minLikes, includeFiller: b.includeFiller !== false };
      }
      function withNowPlaying(history) {
        const np = s.nowPlaying;
        if (!s.party?.active || !np || !(np.maxProgress > 30000) || history.some((h) => h.trackId === np.trackId && h.playedAt >= (np.at - np.progressMs))) return history;
        return [...history, {
          trackId: np.trackId, uri: np.uri, name: np.name, artists: np.artists, image: np.image, addedBy: np.fromQueue?.addedBy || null,
          playedAt: Date.now(), addedAt: np.addedAt, queueLikes: np.queueLikes || 0, playLikes: (np.playLikes || []).length, filler: np.fromQueue ? null : (np.filler || 'host'),
        }];
      }

      adm.get('/history/:partyId', async (req) => {
        const { party: p, history } = historyFor(req.params.partyId);
        return { party: { id: p.id, name: p.name, startedAt: p.startedAt, endedAt: p.endedAt || null }, summary: summarize(history, p), history: [...history].reverse().map(adminHist) };
      });

      adm.post('/playlist/preview', async (req) => {
        const { history } = historyFor(req.body?.partyId);
        const list = selectForPlaylist(withNowPlaying(history), playlistOpts(req.body));
        return { count: list.length, items: list.slice(0, 8).map((h) => ({ name: h.name, artists: h.artists, queueLikes: h.queueLikes, playLikes: h.playLikes })) };
      });

      adm.post('/playlist', async (req) => {
        if (spotify.disabled.has('playlists')) fail(503, 'disabled', 'Guardar playlists no está disponible ahora mismo.');
        const { party: p, history } = historyFor(req.body?.partyId);
        const opts = playlistOpts(req.body);
        const list = selectForPlaylist(withNowPlaying(history), opts);
        if (!list.length) fail(409, 'empty', 'Con esos filtros no sale ninguna canción.');
        const day = new Date(p.startedAt || Date.now()).toLocaleDateString('es-ES');
        const name = String(req.body?.name || '').trim().slice(0, 100) || `${p.name || 'Fiesta'} (${day})`;
        try {
          return await spotify.createPlaylist(name, list.map((h) => h.uri), `Creada por fiesta. el ${day}.`);
        } catch (e) {
          if (e instanceof SpotifyError && (e.status === 403 || e.status === 404)) {
            throw new PartyError(502, 'playlist_failed', 'Spotify no dejó crear la playlist. Prueba a reconectar Spotify desde el panel.');
          }
          throw e;
        }
      });

      adm.post('/summary/show', async (req) => {
        s.showSummary = req.body?.on === true;
        store.save(); changed();
        return { ok: true, showSummary: s.showSummary };
      });

      adm.post('/classics/update', async () => {
        const r = await updateClassics();
        changed();
        return r;
      });
      adm.post('/classics/:trackId/exclude', async (req) => {
        if (!library.setExcluded(req.params.trackId, req.body?.excluded !== false)) fail(404, 'not_found', 'Esa canción no está en tus clásicos.');
        changed();
        return { ok: true };
      });
      adm.post('/classics/restore', async () => {
        for (const t of Object.values(library.data.tracks)) t.excluded = false;
        library.save(); changed();
        return { ok: true };
      });

      adm.get('/qr.svg', async (req, reply) => {
        if (!party.active) fail(404, 'no_party', 'No hay fiesta en marcha.');
        const svg = await QRCode.toString(`${cfg.PUBLIC_URL}/?p=${s.party.pin}`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
        return reply.header('Content-Type', 'image/svg+xml').header('Cache-Control', 'no-store').send(svg);
      });
    }, { prefix: '/admin' });

    // ----- OAuth Spotify -----
    api.get('/spotify/login', async (req, reply) => {
      needAdmin(req);
      if (cfg.MOCK) { spotify.mockConnect(); engine.nudge(50); changed(); return reply.redirect(`${cfg.BASE_PATH}/admin/?spotify=ok`); }
      if (!spotify.configured) return reply.redirect(`${cfg.BASE_PATH}/admin/?spotify=nocreds`);
      const state = randToken(18);
      reply.setCookie('fiesta_oauth', state, cookieOpts(cfg, { maxAgeS: 600, path: `${cfg.BASE_PATH}/api/spotify` }));
      return reply.redirect(spotify.authUrl(state));
    });
    api.get('/spotify/callback', async (req, reply) => {
      needAdmin(req);
      const { code, state, error } = req.query || {};
      const saved = req.cookies.fiesta_oauth;
      reply.clearCookie('fiesta_oauth', cookieOpts(cfg, { path: `${cfg.BASE_PATH}/api/spotify` }));
      const back = (q) => reply.redirect(`${cfg.BASE_PATH}/admin/?${q}`);
      if (error) return back('spotify=denied');
      if (!code || !state || !saved || !safeEqual(state, saved)) return back('spotify=state');
      try {
        await spotify.exchangeCode(String(code));
      } catch (e) {
        app.log.warn('callback: ' + e.message);
        return back('spotify=error');
      }
      s.player.status = 'ok';
      engine.nudge(100); changed();
      return back('spotify=ok');
    });

    // ----- utilidades solo en mock -----
    if (cfg.MOCK) {
      api.get('/_mock/state', async () => ({ mock: mock.ctl.snapshot(), state: { fed: s.fed, queue: s.queue.map((q) => q.name), nowPlaying: s.nowPlaying?.name, pausedByUs: s.pausedByUs, status: s.player.status } }));
      api.post('/_mock/:action', async (req) => {
        const c = mock.ctl; const v = req.body?.value;
        switch (req.params.action) {
          case 'speed': c.setSpeed(v); break;
          case 'disconnect': c.disconnectDevice(); break;
          case 'connect': c.connectDevice(); break;
          case 'rate429': c.rateLimit(v ?? 5); break;
          case 'fail': c.failNext(v ?? 1); break;
          case 'filler': c.startFiller(v ?? 5); break;
          case 'expire': c.expireAccessToken(); break;
          case 'revoke': c.revokeRefresh(); break;
          case 'resetsearch': searchCache.map.clear(); break;
          default: fail(404, 'unknown', 'acción desconocida');
        }
        engine.nudge(50);
        return { ok: true };
      });
    }

    api.setNotFoundHandler((req, reply) => reply.code(404).send({ error: 'not_found', message: 'No existe.' }));
  }, { prefix: API });

  // ================= estaticos =================
  app.get(cfg.BASE_PATH, async (req, reply) => reply.redirect(cfg.BASE_PATH + '/'));
  await app.register(fastifyStatic, {
    root: cfg.PUBLIC_DIR,
    prefix: cfg.BASE_PATH + '/',
    redirect: true,
    index: 'index.html',
    maxAge: 0,
    cacheControl: true,
    setHeaders: (res, p) => { if (/\.(js|css|html)$/.test(p)) res.header('Cache-Control', 'no-cache'); },
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith(API)) return reply.code(404).send({ error: 'not_found', message: 'No existe.' });
    return reply.code(404).type('text/plain; charset=utf-8').send('No encontrado');
  });

  // limpieza periodica
  const gc = setInterval(() => {
    limiters.search.prune(); limiters.action.prune(); limiters.adminLogin.prune(); limiters.joinFail.prune(); limiters.joinAll.prune();
    party.pruneKnown();
  }, 5 * 60 * 1000);
  gc.unref();

  app.addHook('onClose', async () => {
    engine.stop(); hub.close(); clearInterval(gc); store.flush(); library.flush();
  });

  return { app, store, party, engine, spotify, hub, mock, ctx };
}

// ---------- arranque ----------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const problems = assertConfig();
  if (problems.length) { console.error('Configuración incompleta:\n- ' + problems.join('\n- ')); process.exit(1); }
  const { app, engine } = await createApp(config, { logger: true });
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  engine.start();
  console.log(`fiesta escuchando en ${config.PUBLIC_URL} (puerto ${config.PORT}, mock=${config.MOCK})`);
  const bye = async () => { try { await app.close(); } finally { process.exit(0); } };
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
}
