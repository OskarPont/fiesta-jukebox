// E2E con Playwright contra el servidor en modo mock (SPOTIFY_MOCK=1).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
let chromium;
const req = createRequire(import.meta.url);
try { chromium = req('playwright').chromium; } catch { chromium = req('playwright-core').chromium; }
// Navegador: PW_EXECUTABLE (ruta a Chromium), PW_CHANNEL (chrome, msedge) o el Chromium de Playwright.
const launchOpts = () => (process.env.PW_EXECUTABLE ? { executablePath: process.env.PW_EXECUTABLE, args: ['--no-sandbox'] } : process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
const { buildCatalog } = await import(new URL('../src/spotify-mock.js', import.meta.url));
const CAT = buildCatalog();
const T = (i) => CAT[i];

const PORT = 3198;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BASE = `${ORIGIN}/fiesta`;
const ADMIN_KEY = 'clave-de-prueba-123456';
const SHOTS = path.join(here, 'shots-likes');
fs.mkdirSync(SHOTS, { recursive: true });
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fiesta-e2e-'));
const KEEP = process.env.KEEP_SHOTS !== '0';

// ---------- harness ----------
const results = []; let current = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function step(name, fn) {
  current = name;
  const t0 = Date.now();
  try { await fn(); results.push({ name, ok: true }); console.log(`  ok   ${name} (${Date.now() - t0} ms)`); }
  catch (e) { results.push({ name, ok: false, err: e }); console.log(`  FAIL ${name}\n       ${String(e.message).split('\n')[0]}`); }
}
function expect(cond, msg) { if (!cond) throw new Error(msg || 'expect fallo'); }
async function waitFor(fn, { timeout = 5000, interval = 60, msg = 'waitFor' } = {}) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(interval);
  }
  throw new Error(`${msg} (timeout ${timeout} ms)${last ? ': ' + last.message : ''}`);
}

// ---------- servidor ----------
let server = null; let serverLog = '';
async function startServer(speed = 1) {
  server = spawn(process.execPath, [path.join(root, 'src/server.js')], {
    env: { ...process.env, SPOTIFY_MOCK: '1', MOCK_SPEED: String(speed), PORT: String(PORT), DATA_DIR: DATA, ADMIN_KEY, COOKIE_SECRET: 'secreto-de-prueba-de-32-caracteres!!', HB_MS: '1000', LOG_LEVEL: 'warn', PUBLIC_URL: BASE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  await waitFor(async () => (await fetch(`${BASE}/api/health`)).ok, { timeout: 8000, msg: 'servidor no arranca' });
}
async function stopServer() {
  if (!server) return;
  const p = server; server = null;
  p.kill('SIGTERM');
  await new Promise((r) => { p.on('exit', r); setTimeout(r, 3000); });
}

// ---------- navegador ----------
const consoleErrors = [];
function watch(page, label) {
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/Failed to load resource.*status of (401|403|404|409|429|503)/.test(t)) return; // errores HTTP provocados a proposito
    if (/Failed to load resource: net::ERR_CONNECTION_(REFUSED|RESET)/.test(t)) return; // el test reinicia el servidor
    consoleErrors.push(`[${label}] ${t}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`[${label}] pageerror: ${e.message}`));
}
async function newCtx(browser, kind) {
  const opts = kind === 'mobile'
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    : kind === 'tv' ? { viewport: { width: 1920, height: 1080 } }
      : kind === 'laptop' ? { viewport: { width: 1366, height: 768 } }
        : { viewport: { width: 1280, height: 900 } };
  const ctx = await browser.newContext({ ...opts, locale: 'es-ES', baseURL: BASE + '/' });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  return ctx;
}
const shot = async (page, name, opts = {}) => { await page.screenshot({ path: path.join(SHOTS, `${name}.png`), ...opts }); };

// ---------- helpers de app ----------
async function api(ctx, method, p, data) {
  const r = await ctx.request.fetch(`${BASE}/api/${p}`, { method, data: data ?? undefined, headers: method === 'DELETE' || method === 'GET' ? {} : { 'content-type': 'application/json' } });
  let body = null; try { body = await r.json(); } catch { /* */ }
  return { status: r.status(), body };
}
const mockState = async () => (await (await fetch(`${BASE}/api/_mock/state`)).json());
const mockCmd = async (action, value) => fetch(`${BASE}/api/_mock/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }) });

async function guestJoin(page, pin, name, { viaLink = false } = {}) {
  await page.goto(viaLink ? `?p=${pin}` : '');
  await page.waitForSelector('#view-join:not([hidden])');
  if (!viaLink) await page.fill('#pin', pin);
  await page.fill('#name', name);
  await page.click('#joinBtn');
}
async function guestAdd(page, track) {
  await page.fill('#q', track.name.toLowerCase());
  const row = page.locator('#resultsList .res', { hasText: track.name }).first();
  await row.waitFor({ timeout: 4000 });
  await row.locator('.add-btn:not([disabled])').click();
  await waitFor(async () => (await page.locator('#queue .q-item .q-title', { hasText: track.name }).count()) > 0 || (await page.locator('#npTitle', { hasText: track.name }).count()) > 0, { msg: `no aparece ${track.name} en cola` });
}
const queueTitles = (page) => page.locator('#queue .q-item .q-title').allTextContents();
const clean = (arr) => arr.map((s) => s.replace(/^E\s*/, '').trim());

async function main() {
  await startServer(1);
  const browser = await chromium.launch(launchOpts());
  const adminCtx = await newCtx(browser, 'desktop');
  const admin = await adminCtx.newPage(); watch(admin, 'admin');
  const [A, B, C] = [T(1), T(2), T(3)];
  let pin;
  const gctx = []; const g = [];

  console.log('\nA. Preparación');
  await step('admin conecta, elige dispositivo y empieza fiesta', async () => {
    expect((await api(adminCtx, 'POST', 'admin/login', { key: ADMIN_KEY })).status === 200, 'login');
    await adminCtx.request.get(`${BASE}/api/spotify/login`, { maxRedirects: 0 }).catch(() => {});
    const d = await api(adminCtx, 'GET', 'admin/devices');
    await api(adminCtx, 'POST', 'admin/device', { deviceId: d.body.devices[0].id });
    await api(adminCtx, 'PUT', 'admin/settings', { addCooldownSec: 0, skipMode: 'direct', controlCooldownSec: 0, globalControlCooldownSec: 0 });
    const r = await api(adminCtx, 'POST', 'admin/party/start', { name: 'Fiesta uno' });
    pin = r.body.party.pin;
    await admin.goto('admin/');
    await admin.waitForSelector('#dash:not([hidden])');
  });
  await step('3 invitados entran', async () => {
    for (const [i, name] of ['Laura', 'Marc', 'Pau'].entries()) {
      gctx[i] = await newCtx(browser, 'mobile'); g[i] = await gctx[i].newPage(); watch(g[i], 'g' + (i + 1));
      await guestJoin(g[i], pin, name);
      await g[i].waitForSelector('#view-main:not([hidden])');
    }
  });

  console.log('\nB. Likes en cola y sonando');
  await step('Laura pide A (suena), Marc pide B, Pau vota B en cola', async () => {
    await guestAdd(g[0], A);
    await waitFor(async () => (await g[0].textContent('#npTitle')).includes(A.name), { timeout: 6000, msg: 'A no suena' });
    await guestAdd(g[1], B);
    await g[2].locator('#queue .q-item', { hasText: B.name }).locator('.vote').click();
    await waitFor(async () => (await g[0].locator('#queue .q-item', { hasText: B.name }).locator('.vote').textContent()).includes('1'));
  });
  await step('like a la que suena: Laura no puede (es suya), Marc y Pau sí', async () => {
    await waitFor(async () => !(await g[1].isHidden('#btnLike')));
    expect(await g[0].locator('#btnLike').isDisabled(), 'like propio desactivado');
    // momento propio: solo para quien pidió la canción
    await waitFor(async () => (await g[0].locator('.np.mine').count()) === 1, { msg: 'Laura ve .np.mine' });
    expect((await g[0].textContent('#npKicker')).trim() === '¡Suena tu canción!', 'kicker de Laura');
    expect((await g[0].textContent('#npBy')).trim() === 'La has pedido tú', 'chip de Laura');
    expect((await g[0].getAttribute('.np', 'aria-label')) === 'Ahora suena', 'aria-label de la sección intacto');
    for (const i of [1, 2]) {
      expect((await g[i].locator('.np.mine').count()) === 0, `g${i} sin .mine`);
      expect((await g[i].textContent('#npKicker')).trim() === 'Ahora suena', `kicker de g${i}`);
      expect(await g[i].locator('#btnLike').isEnabled(), `like de g${i} activo`);
      expect(!(await g[i].locator('#btnLike').evaluate((e) => e.classList.contains('own'))), `g${i} sin .own`);
    }
    expect((await g[0].locator('#btnLike').getAttribute('aria-label')) === 'Likes a tu canción: 0', 'aria 0 likes');
    expect(await g[1].locator('#btnLike svg path[d^="M19 14c1.49"]').count() === 1 && await g[1].locator('#btnLike svg path[d="M12 19V5"]').count() === 0, 'el me gusta de lo que suena sigue siendo el corazon');
    await g[1].click('#btnLike');
    await waitFor(async () => (await g[1].getAttribute('#btnLike', 'aria-pressed')) === 'true', { msg: 'like de Marc' });
    await waitFor(async () => (await g[0].textContent('#btnLike')).trim() === '1' && (await g[0].getAttribute('#btnLike', 'aria-label')) === 'Likes a tu canción: 1', { msg: 'Laura ve 1 like' });
    expect((await g[0].getAttribute('#btnLike', 'title')) === 'Los likes que recibe tu canción', 'title del contador');
    await g[2].click('#btnLike');
    await waitFor(async () => (await g[0].textContent('#btnLike')).trim() === '2' && (await g[0].getAttribute('#btnLike', 'aria-label')) === 'Likes a tu canción: 2', { msg: 'Laura ve 2 likes' });
    expect(await g[0].locator('#btnLike').isDisabled(), 'sigue desactivado');
    // movimiento reducido: sin pulso del halo ni rebote del corazón
    await g[0].emulateMedia({ reducedMotion: 'reduce' });
    const probe = () => g[0].evaluate(() => {
      const glow = getComputedStyle(document.querySelector('.np.mine .cover-halo'), '::before');
      const wrap = getComputedStyle(document.querySelector('.np.mine .cover-wrap'));
      return { halo: glow.animationName, state: glow.animationPlayState, glowShadow: glow.boxShadow, glowOpacity: glow.opacity, wrapAnim: wrap.animationName, ring: wrap.boxShadow, heart: getComputedStyle(document.querySelector('#btnLike .ico')).animationName };
    });
    const isAccent = (v) => /255, 77, 133/.test(v) || v.includes('#ff4d85') || v.includes('oklab') || v.includes('color(');
    const anim = await probe();
    expect(anim.halo === 'none' && anim.heart === 'none', 'sin animación con movimiento reducido: ' + JSON.stringify(anim));
    expect(isAccent(anim.ring) && / 2px/.test(anim.ring), 'el anillo estático sigue visible: ' + anim.ring);
    expect(isAccent(anim.glowShadow) && Number(anim.glowOpacity) > 0, 'el resplandor sigue visible sin animar: ' + JSON.stringify(anim));
    await g[0].emulateMedia({ reducedMotion: 'no-preference' });
    const norm = await probe();
    expect(norm.halo === 'halo', 'halo animado con movimiento normal: ' + JSON.stringify(norm));
    expect(norm.wrapAnim === 'none', 'la caratula en sí no se anima (sin box-shadow por fotograma)');
    expect(norm.state === 'running', 'pulso en marcha mientras suena: ' + norm.state);
    const kfProps = await g[0].evaluate(() => {
      const props = new Set();
      for (const sheet of document.styleSheets) for (const r of sheet.cssRules) if (r.type === CSSRule.KEYFRAMES_RULE && r.name === 'halo') for (const k of r.cssRules) for (const p of k.style) props.add(p);
      return [...props];
    });
    expect(kfProps.length === 1 && kfProps[0] === 'opacity', 'los keyframes del halo solo tocan opacity: ' + kfProps.join(','));
    await g[0].evaluate(() => window.scrollTo(0, 0));
    await sleep(300);
    await shot(g[0], 'L0-guest-tu-cancion', { fullPage: false });
    // en pausa el pulso se detiene; al reanudar vuelve
    try {
      expect((await api(adminCtx, 'POST', 'admin/control/pause')).status === 200, 'el anfitrión pausa');
      await waitFor(async () => (await g[0].evaluate(() => !document.querySelector('#pausedBadge').hidden)), { msg: 'Laura ve En pausa' });
      await waitFor(async () => (await probe()).state === 'paused', { msg: 'el pulso se detiene en pausa' });
    } finally {
      await api(adminCtx, 'POST', 'admin/control/resume');
    }
    await waitFor(async () => (await g[0].evaluate(() => document.querySelector('#pausedBadge').hidden)), { msg: 'Laura ve que sigue' });
    await waitFor(async () => (await probe()).state === 'running', { msg: 'el pulso vuelve al reanudar' });
    const own = await api(gctx[0], 'POST', 'nowplaying/like');
    expect(own.status === 403, 'API rechaza like propio');
    // quitar y volver a poner
    await g[2].click('#btnLike');
    await waitFor(async () => (await g[0].textContent('#btnLike')).trim() === '1');
    await g[2].click('#btnLike');
    await waitFor(async () => (await g[0].textContent('#btnLike')).trim() === '2');
    await waitFor(async () => (await admin.locator('#card-player .lk').first().getAttribute('title').catch(() => '')) === '2 likes · 0 votos', { msg: 'admin ve el desglose de A' });
    await shot(g[1], 'L1-guest-like', { fullPage: false });
  });
  await step('B suena con su like de cola y recibe un like sonando', async () => {
    await mockCmd('speed', 40);
    await waitFor(async () => (await g[0].textContent('#npTitle')).includes(B.name), { timeout: 12000, msg: 'B no suena' });
    await mockCmd('speed', 1);
    await waitFor(async () => (await g[0].locator('.np.mine').count()) === 0 && (await g[1].locator('.np.mine').count()) === 1, { msg: 'el estado propio pasa de Laura a Marc' });
    expect((await g[0].textContent('#npKicker')).trim() === 'Ahora suena' && (await g[1].textContent('#npKicker')).trim() === '¡Suena tu canción!', 'kickers tras cambiar');
    expect((await g[0].textContent('#npBy')).includes('Pedida por Marc'), 'Laura ve «Pedida por Marc»');
    await waitFor(async () => (await g[1].textContent('#btnLike')).trim() === '0', { msg: 'B arranca sin likes: el voto de cola no cuenta en el corazón' });
    await g[0].click('#btnLike');
    await waitFor(async () => (await g[1].textContent('#btnLike')).trim() === '1', { msg: 'B ve 1 like sonando' });
    await waitFor(async () => (await admin.locator('#card-player .lk').first().getAttribute('title').catch(() => '')) === '1 like · 1 voto', { msg: 'admin desglose B' });
  });
  await step('C (de Pau) sin likes; el historial guarda el desglose', async () => {
    await guestAdd(g[2], C);
    await mockCmd('speed', 40);
    await waitFor(async () => (await g[0].textContent('#npTitle')).includes(C.name), { timeout: 12000, msg: 'C no suena' });
    await waitFor(async () => (await admin.locator('#card-history .ah-item').count()) >= 2, { msg: 'historial' });
    const titles = await admin.locator('#card-history .lk').evaluateAll((els) => els.map((e) => e.title));
    expect(titles.includes('2 likes · 0 votos') && titles.includes('1 like · 1 voto'), 'desglose en historial: ' + titles.join(' | '));
    await mockCmd('speed', 1);
  });

  console.log('\nC. Resumen y playlists');
  await step('resumen: canción de la noche A, mejor DJ Laura', async () => {
    await waitFor(async () => (await admin.textContent('#card-history .sum')).includes(A.name), { msg: 'canción de la noche' });
    const t = await admin.textContent('#card-history .sum');
    expect(t.includes('Laura'), 'mejor DJ Laura: ' + t);
    expect(t.includes('DJ de la noche') && !t.includes('Mejor DJ'), 'fila «DJ de la noche»: ' + t);
    expect(/\d+ likes? · \d+ votos?/.test(t), 'meta «N likes · M votos»: ' + t);
    expect(!t.includes('Más canciones puestas'), 'sin «Más canciones puestas»: ' + t);
    await admin.locator('#card-history').scrollIntoViewIfNeeded();
    await shot(admin, 'L2-admin-history', { fullPage: true });
  });
  await step('playlist: vista previa con filtros y creación', async () => {
    const base = { partyId: 'current' };
    let r = await api(adminCtx, 'POST', 'admin/playlist/preview', { ...base });
    expect(r.body.count === 2, 'todas (A y B; C sonando <30 s): ' + JSON.stringify(r.body));
    r = await api(adminCtx, 'POST', 'admin/playlist/preview', { ...base, minLikes: 1, likeType: 'queue' });
    expect(r.body.count === 1 && r.body.items[0].name === B.name, 'solo B tiene like en cola');
    r = await api(adminCtx, 'POST', 'admin/playlist/preview', { ...base, order: 'likes_desc', likeType: 'play' });
    expect(r.body.items[0].name === A.name, 'A primero por likes sonando');
    await admin.click('#card-history .builder summary');
    await admin.locator('#card-history .builder .seg button', { hasText: 'Con mínimo de likes y votos' }).click();
    await admin.locator('#card-history .builder .seg button', { hasText: 'Solo likes' }).click();
    expect((await admin.locator('#card-history .builder .seg button', { hasText: 'Solo likes' }).getAttribute('aria-pressed')) === 'true', 'Solo likes seleccionado');
    await admin.selectOption('#card-history .builder select', 'likes_desc');
    await admin.fill('#card-history .builder input[maxlength="100"]', 'Lo mejor de la fiesta');
    await waitFor(async () => (await admin.textContent('#card-history .pv')).includes('Saldrán 2 canciones'), { msg: 'preview UI' });
    await sleep(400);
    await shot(admin, 'L3-admin-builder', { fullPage: true });
    await admin.click('#card-history button:has-text("Crear playlist en Spotify")');
    await admin.waitForSelector('#card-history a:has-text("Abrir en Spotify")', { timeout: 6000 });
    const st = await mockState();
    const pl = st.mock.playlists.find((p) => p.name === 'Lo mejor de la fiesta');
    expect(pl && pl.uris.length === 2 && pl.uris[0] === A.uri, 'playlist ordenada: ' + JSON.stringify(pl));
  });
  await step('resumen en la pantalla', async () => {
    const tvCtx = await newCtx(browser, 'tv');
    await api(tvCtx, 'POST', 'admin/login', { key: ADMIN_KEY });
    const tv = await tvCtx.newPage(); watch(tv, 'tv');
    await tv.goto('pantalla/');
    await tv.waitForSelector('#stage:not([hidden])');
    await waitFor(async () => (await tv.textContent('#npLikes')).trim() !== '' || true);
    await sleep(1000);
    await shot(tv, 'L4-pantalla-likes');
    await admin.click('#card-history button:has-text("Mostrar resumen en la pantalla")');
    await tv.waitForSelector('#summary:not([hidden])', { timeout: 4000 });
    expect((await tv.textContent('#sumSongName')).includes(A.name), 'canción de la noche en TV');
    const tvSum = await tv.textContent('#summary');
    expect(tvSum.includes('DJ de la noche') && !tvSum.includes('Mejor DJ') && !tvSum.includes('Más canciones'), 'textos del resumen en TV: ' + tvSum);
    expect(/^\d+ likes? · \d+ votos?$/.test((await tv.textContent('#sumDjMeta')).trim()), 'meta del DJ en TV: ' + (await tv.textContent('#sumDjMeta')));
    expect((await tv.locator('#sumActive').count()) === 0, 'sin bloque sumActive');
    await sleep(1200);
    await shot(tv, 'L5-pantalla-resumen');
    await admin.click('#card-history button:has-text("Quitar resumen de la pantalla")');
    await tv.waitForSelector('#summary[hidden]', { state: 'attached', timeout: 4000 });
    await tvCtx.close();
  });

  console.log('\nD. Clásicos y relleno inteligente');
  await step('al terminar la fiesta se archiva y se crea "Clásicos de fiesta"', async () => {
    await api(adminCtx, 'POST', 'admin/party/stop', { kickAll: true });
    await waitFor(async () => (await mockState()).mock.playlists.some((p) => p.name === 'Clásicos de fiesta'), { msg: 'playlist clásicos' });
    const pl = (await mockState()).mock.playlists.find((p) => p.name === 'Clásicos de fiesta');
    expect(pl.uris.length === 1 && pl.uris[0] === A.uri, 'solo A llega a 2 puntos: ' + JSON.stringify(pl.uris));
    await waitFor(async () => (await admin.textContent('#card-classics')).includes(A.name), { msg: 'tarjeta clásicos' });
    expect((await admin.textContent('#card-classics')).includes('2 pts'), 'puntos');
  });
  await step('actualizar clásicos reutiliza la misma playlist', async () => {
    await api(adminCtx, 'PUT', 'admin/settings', { classicsMinScore: 1 });
    const r = await api(adminCtx, 'POST', 'admin/classics/update');
    expect(r.status === 200 && r.body.count === 2, 'A y B: ' + JSON.stringify(r.body));
    const pls = (await mockState()).mock.playlists.filter((p) => p.name === 'Clásicos de fiesta');
    expect(pls.length === 1 && pls[0].uris.length === 2, 'misma playlist con 2');
    await api(adminCtx, 'POST', `admin/classics/${encodeURIComponent(B.id)}/exclude`, { excluded: true });
    await waitFor(async () => !(await admin.textContent('#card-classics')).includes(B.name), { msg: 'B quitada' });
    await waitFor(async () => (await admin.textContent('#card-classics')).includes('1 quitada a mano'));
    await admin.locator('#card-classics').scrollIntoViewIfNeeded();
    await shot(admin, 'L6-admin-classics', { fullPage: true });
    await api(adminCtx, 'POST', 'admin/classics/restore');
    await api(adminCtx, 'PUT', 'admin/settings', { classicsMinScore: 2 });
  });
  await step('nueva fiesta con la cola vacía: suena un clásico', async () => {
    const r = await api(adminCtx, 'POST', 'admin/party/start', { name: 'Fiesta dos' });
    pin = r.body.party.pin;
    await mockCmd('speed', 40);
    await waitFor(async () => { const s = await mockState(); return s.mock.queue.includes(A.name) || s.mock.current === A.name; }, { timeout: 15000, msg: 'el clásico A no entra' });
    await waitFor(async () => (await mockState()).mock.current === A.name, { timeout: 15000, msg: 'A no suena' });
    await mockCmd('speed', 1);
    await guestJoin(g[0], pin, 'Laura'); await g[0].waitForSelector('#view-main:not([hidden])');
    await waitFor(async () => (await g[0].textContent('#npBy')).includes('Clásico de otras fiestas'), { msg: 'chip clásico' });
    await shot(g[0], 'L7-guest-classic', { fullPage: false });
  });
  await step('el admin puede ver la fiesta anterior y su resumen', async () => {
    const parties = await admin.locator('#card-history select.sel option').allTextContents();
    expect(parties.some((t) => t.includes('Fiesta uno')), 'fiesta uno en el selector: ' + parties);
    const opt = await admin.locator('#card-history select.sel option', { hasText: 'Fiesta uno' }).getAttribute('value');
    await admin.selectOption('#card-history select.sel', opt);
    await waitFor(async () => (await admin.textContent('#card-history .sum')).includes(A.name), { msg: 'resumen fiesta uno' });
    const r = await api(adminCtx, 'POST', 'admin/playlist/preview', { partyId: opt });
    expect(r.body.count >= 2, 'preview de fiesta pasada');
  });

  await step('admin en móvil sin scroll horizontal', async () => {
    await admin.setViewportSize({ width: 390, height: 844 });
    await sleep(500);
    const over = await admin.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(over <= 1, 'desborde horizontal: ' + over);
    await admin.locator('#card-history').screenshot({ path: path.join(SHOTS, 'L8-admin-history-mobile.png') });
    await admin.locator('#card-classics').screenshot({ path: path.join(SHOTS, 'L9-admin-classics-mobile.png') });
  });
  await step('sin errores de consola', async () => {
    expect(consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' || '));
  });
  await browser.close();
  await stopServer();
}

try { await main(); } catch (e) { console.error('Error fatal en el test:', e); results.push({ name: 'fatal: ' + current, ok: false, err: e }); }
await stopServer();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} pasos correctos`);
if (failed.length) { for (const f of failed) console.log(' -', f.name, '\n   ', f.err?.message?.split('\n')[0]); console.log('\nLog del servidor:\n' + serverLog.slice(-1500)); }
fs.rmSync(DATA, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
