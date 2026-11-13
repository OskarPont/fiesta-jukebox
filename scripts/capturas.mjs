// Genera las capturas del README (docs/capturas/*.png) contra el servidor en modo mock.
// Uso:  timeout 300 node scripts/capturas.mjs
// Necesita playwright-core (npm i --no-save playwright-core). Navegador: PW_EXECUTABLE, PW_CHANNEL o el Chromium de Playwright.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const OUT = path.join(root, 'docs', 'capturas');
let chromium;
const req = createRequire(import.meta.url);
try { chromium = req('playwright').chromium; } catch { chromium = req('playwright-core').chromium; }
const launchOpts = () => (process.env.PW_EXECUTABLE ? { executablePath: process.env.PW_EXECUTABLE, args: ['--no-sandbox'] } : process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
const { buildCatalog } = await import(new URL('../src/spotify-mock.js', import.meta.url));
const CAT = buildCatalog();
const T = (i) => CAT[i];

const PORT = 3198;
const BASE = `http://127.0.0.1:${PORT}/fiesta`;
const ADMIN_KEY = 'clave-de-capturas-123456';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fiesta-capturas-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 8000, interval = 80, msg = 'waitFor' } = {}) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(interval);
  }
  throw new Error(`${msg} (timeout ${timeout} ms)${last ? ': ' + last.message : ''}`);
}

// ---------- servidor ----------
let server = null; let serverLog = '';
async function startServer() {
  server = spawn(process.execPath, [path.join(root, 'src/server.js')], {
    env: { ...process.env, SPOTIFY_MOCK: '1', MOCK_SPEED: '1', PORT: String(PORT), DATA_DIR: DATA, ADMIN_KEY, COOKIE_SECRET: 'secreto-de-capturas-de-32-caracteres!!', HB_MS: '1000', LOG_LEVEL: 'warn', PUBLIC_URL: BASE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  await waitFor(async () => (await fetch(`${BASE}/api/health`)).ok, { timeout: 10000, msg: 'servidor no arranca' });
}
async function stopServer() {
  if (!server) return;
  const p = server; server = null;
  p.kill('SIGTERM');
  await new Promise((r) => { p.on('exit', r); setTimeout(r, 3000); });
}

// ---------- helpers ----------
async function newCtx(browser, kind) {
  const opts = kind === 'mobile' ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    : kind === 'tv' ? { viewport: { width: 1920, height: 1080 } } : { viewport: { width: 1440, height: 900 } };
  const ctx = await browser.newContext({ ...opts, locale: 'es-ES', baseURL: BASE + '/' });
  // la ayuda «Cómo funciona» se abre sola la primera vez: se marca como vista salvo en la captura de la ayuda
  await ctx.addInitScript(() => { try { if (!sessionStorage.getItem('__c')) { sessionStorage.setItem('__c', '1'); localStorage.setItem('fiesta.help.seen', '1'); } } catch { /* */ } });
  return ctx;
}
async function api(ctx, method, p, data, tries = 6) {
  let r = await ctx.request.fetch(`${BASE}/api/${p}`, { method, data: data ?? undefined, headers: method === 'DELETE' || method === 'GET' ? {} : { 'content-type': 'application/json' } });
  if (r.status() === 429 && tries > 0) { await sleep(1100); return api(ctx, method, p, data, tries - 1); }  // limitador por invitado
  let body = null; try { body = await r.json(); } catch { /* */ }
  if (r.status() >= 400) throw new Error(`${method} ${p} -> ${r.status()} ${JSON.stringify(body)}`);
  return body;
}
const mockState = async () => (await (await fetch(`${BASE}/api/_mock/state`)).json());
const mockCmd = async (action, value) => fetch(`${BASE}/api/_mock/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }) });

// espera a que carguen las imágenes visibles (portadas, QR) y las fuentes, y a que acaben las animaciones de entrada
async function settle(page, { ms = 800 } = {}) {
  await page.addStyleTag({ content: '#toasts,#bigToasts{display:none!important}.fs-hint{display:none!important}' });
  await page.evaluate(() => document.querySelectorAll('img[loading=lazy]').forEach((i) => { i.loading = 'eager'; }));  // las de fuera de pantalla también
  // sin waitForFunction: choca con la CSP de las páginas
  await waitFor(() => page.evaluate(() => [...document.images].filter((i) => i.getBoundingClientRect().width > 0 && !i.closest('[hidden]')).every((i) => i.complete && i.naturalWidth > 0)), { msg: 'imágenes sin cargar: ' + JSON.stringify(await page.evaluate(() => [...document.images].filter((i) => !(i.complete && i.naturalWidth > 0)).map((i) => [i.id, i.className, i.loading, i.src.slice(0, 60), Math.round(i.getBoundingClientRect().width), !!i.closest('[hidden]')]))) });
  await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
  await sleep(ms);
}
const shot = async (page, name, opts = {}) => {
  await settle(page);
  const png = path.join(OUT, `${name}.png`); const jpg = path.join(OUT, `${name}.jpg`);
  fs.rmSync(png, { force: true }); fs.rmSync(jpg, { force: true });
  await page.screenshot({ path: png, ...opts });
  let kb = Math.round(fs.statSync(png).size / 1024);
  if (kb > 600) {  // demasiado pesada para el README: se guarda como JPEG (calidad 85)
    fs.rmSync(png);
    await page.screenshot({ path: jpg, type: 'jpeg', quality: 85, ...opts });
    kb = Math.round(fs.statSync(jpg).size / 1024);
    console.log(`  ok   ${name}.jpg (${kb} KB, JPEG por peso)`);
  } else console.log(`  ok   ${name}.png (${kb} KB)`);
};

// ---------- principal ----------
const log = (m) => console.log('..', m);
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  let browser = null;
  try {
    await startServer();
    browser = await chromium.launch(launchOpts());
    // --- admin: conectar Spotify (mock), dispositivo, fiesta ---
    const adminCtx = await newCtx(browser, 'desktop');
    await api(adminCtx, 'POST', 'admin/login', { key: ADMIN_KEY });
    await adminCtx.request.get(`${BASE}/api/spotify/login`);
    const devs = await waitFor(async () => { const d = (await api(adminCtx, 'GET', 'admin/devices')).devices; return d.length ? d : null; }, { msg: 'sin dispositivos' });
    await api(adminCtx, 'POST', 'admin/device', { deviceId: devs[0].id });
    await api(adminCtx, 'POST', 'admin/party/start', { name: 'Cumple de Lucía' });
    const pin = (await api(adminCtx, 'GET', 'admin/status')).party.pin;
    await api(adminCtx, 'PUT', 'admin/settings', { addCooldownSec: 0, controlCooldownSec: 0, globalControlCooldownSec: 0, maxQueuedPerGuest: 10, noRepeatMin: 0, ordering: 'votes' });

    log('fiesta iniciada');
    // --- invitados (cada uno con su contexto de navegador) ---
    const names = ['Lucía', 'Marc', 'Carla', 'Pau', 'Íñigo'];
    const G = {};
    for (const n of names) {
      const ctx = await newCtx(browser, 'mobile');
      await api(ctx, 'POST', 'join', { pin, name: n });
      G[n] = ctx;
    }
    const QID = {};
    const add = async (who, t) => { await api(G[who], 'GET', `search?q=${encodeURIComponent(t.name.toLowerCase())}`); const r = await api(G[who], 'POST', 'queue', { uri: t.uri }); QID[t.name] = r.item.qid; };
    const playingIs = (t) => waitFor(async () => { const s = await mockState(); return s.mock.current === t.name && s.mock.playing && s.state.nowPlaying === t.name; }, { timeout: 15000, msg: 'no suena ' + t.name });

    log('invitados listos');
    // historial: dos canciones que ya han sonado, y después suena la de Íñigo
    const H1 = T(0); const H2 = T(1); const NOW = T(2);
    await add('Marc', H1); await add('Carla', H2); await add('Íñigo', NOW);
    await playingIs(H1);
    for (const w of ['Carla', 'Pau', 'Íñigo']) await api(G[w], 'POST', 'nowplaying/like');
    await api(adminCtx, 'POST', 'admin/control/skip'); await playingIs(H2);
    for (const w of ['Marc', 'Lucía', 'Pau']) await api(G[w], 'POST', 'nowplaying/like');
    await api(adminCtx, 'POST', 'admin/control/skip'); await playingIs(NOW);

    log('suena la canción de Íñigo');
    // cola: la de Lucía queda la 2.ª
    const Q = [['Pau', T(3)], ['Lucía', T(5)], ['Carla', T(6)], ['Marc', T(7)], ['Lucía', T(9)], ['Íñigo', T(10)], ['Pau', T(11)]];
    for (const [who, t] of Q) await add(who, t);
    const vote = async (who, t) => api(G[who], 'POST', `queue/${QID[t.name]}/vote`);
    for (const w of ['Marc', 'Carla', 'Íñigo']) await vote(w, T(3));
    for (const w of ['Marc', 'Carla']) await vote(w, T(5));
    await vote('Pau', T(6)); await vote('Lucía', T(6)); await vote('Íñigo', T(7));
    for (const w of ['Marc', 'Carla', 'Pau', 'Lucía']) await api(G[w], 'POST', 'nowplaying/like');

    // la canción lleva un rato sonando: se acelera el reloj del mock un instante
    await mockCmd('speed', 20); await sleep(3500); await mockCmd('speed', 1);
    await waitFor(async () => (await mockState()).mock.current === NOW.name, { msg: 'la canción cambió' });

    // --- invitado Lucía: cola completa, búsqueda y ayuda ---
    const lp = await G['Lucía'].newPage();
    await lp.goto('');
    await lp.waitForSelector('#queue .q-item');
    await waitFor(async () => (await lp.locator('#queue .q-by', { hasText: 'Tu canción · n.º 2' }).count()) === 1, { msg: 'Tu canción n.º 2' });
    await shot(lp, 'invitado-cola', { fullPage: true });

    await lp.fill('#q', 'luna');
    await lp.waitForSelector('#resultsList .res');
    await shot(lp, 'invitado-busqueda');
    await lp.fill('#q', ''); await lp.keyboard.press('Escape');

    await lp.evaluate(() => localStorage.removeItem('fiesta.help.seen'));
    await lp.reload();
    await lp.waitForSelector('dialog[open], [role=dialog]:not([hidden])', { timeout: 5000 });
    await shot(lp, 'invitado-ayuda');
    await lp.close();

    // --- invitado Íñigo: suena su canción ---
    const ip = await G['Íñigo'].newPage();
    await ip.goto('');
    await ip.waitForSelector('#queue .q-item');
    await sleep(500);
    await shot(ip, 'invitado-tu-cancion');
    await ip.close();

    // --- pantalla (TV): necesita la sesión de admin ---
    const tvCtx = await newCtx(browser, 'tv');
    await api(tvCtx, 'POST', 'admin/login', { key: ADMIN_KEY });
    const tv = await tvCtx.newPage();
    await tv.goto('pantalla/');
    await tv.waitForSelector('#qr');
    await shot(tv, 'pantalla');
    await api(adminCtx, 'POST', 'admin/summary/show', { on: true });
    await tv.waitForSelector('#sumBand:not([hidden])', { timeout: 5000 });
    await shot(tv, 'pantalla-resumen');
    await api(adminCtx, 'POST', 'admin/summary/show', { on: false });
    await tv.close();

    // --- panel de administración ---
    const pcx = await newCtx(browser, 'desktop');
    await api(pcx, 'POST', 'admin/login', { key: ADMIN_KEY });
    const pd = await pcx.newPage();
    await pd.goto('admin/');
    await pd.waitForSelector('#dash:not([hidden])');
    await pd.waitForSelector('#card-party .pin-big');
    await waitFor(() => pd.evaluate(() => (document.querySelector('#card-party .qr-mini img')?.naturalWidth || 0) > 0), { msg: 'QR del panel' });
    await shot(pd, 'panel-escritorio', { fullPage: true });
    await pd.close();
    const pmCtx = await newCtx(browser, 'mobile');
    await api(pmCtx, 'POST', 'admin/login', { key: ADMIN_KEY });
    const pm = await pmCtx.newPage();
    await pm.goto('admin/');
    await pm.waitForSelector('#dash:not([hidden])');
    await pm.waitForSelector('#card-party .pin-big');
    await waitFor(() => pm.evaluate(() => (document.querySelector('#card-party .qr-mini img')?.naturalWidth || 0) > 0), { msg: 'QR del panel móvil' });
    await shot(pm, 'panel-movil');
    await pm.close();

    // --- despedida (siempre la última) ---
    const dp = await G['Marc'].newPage();
    await dp.goto('');
    await dp.waitForSelector('#queue .q-item');
    await api(adminCtx, 'POST', 'admin/party/stop', { kickAll: true });
    await dp.waitForSelector('#farewell:not([hidden])', { timeout: 8000 });
    await shot(dp, 'despedida', { fullPage: true });
  } finally {
    await browser?.close().catch(() => {});
    await stopServer();
    fs.rmSync(DATA, { recursive: true, force: true });
  }
}
main().catch((e) => { console.error('ERROR:', e.message); if (serverLog) console.error(serverLog.slice(-1500)); process.exitCode = 1; });
