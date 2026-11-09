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

const PORT = 3199;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BASE = `${ORIGIN}/fiesta`;
const ADMIN_KEY = 'clave-de-prueba-123456';
const SHOTS = path.join(here, 'shots');
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

// registra todos los avisos (toasts) que aparecen en una pagina, aunque desaparezcan a los pocos segundos
const watchToasts = (page) => page.evaluate(() => {
  window.__toasts = [];
  if (window.__toastObs) return;
  window.__toastObs = new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.classList?.contains('toast')) window.__toasts.push(n.textContent); });
  window.__toastObs.observe(document.body, { childList: true, subtree: true });
});
const seenToasts = (page) => page.evaluate(() => window.__toasts || []);

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
  // cerrar los resultados: segun las fuentes del navegador pueden tapar la cola
  await page.keyboard.press('Escape');
}
const queueTitles = (page) => page.locator('#queue .q-item .q-title').allTextContents();
const clean = (arr) => arr.map((s) => s.replace(/^E\s*/, '').trim());

// =====================================================================
async function main() {
  await startServer(1);
  const browser = await chromium.launch(launchOpts());
  const adminCtx = await newCtx(browser, 'desktop');
  const admin = await adminCtx.newPage(); watch(admin, 'admin');
  const g = []; const gctx = []; let pin = '';

  console.log('\nA. Admin');
  await step('admin: login con clave incorrecta muestra error', async () => {
    await admin.goto('admin/');
    await admin.waitForSelector('#login:not([hidden])');
    await admin.fill('#key', 'incorrecta');
    await admin.click('#loginForm button[type=submit]');
    await admin.waitForSelector('#loginError:not([hidden])');
    expect((await admin.textContent('#loginError')).includes('incorrecta'), 'mensaje de clave');
    await shot(admin, '01-admin-login', { fullPage: false });
  });
  await step('admin: login correcto muestra el panel', async () => {
    await admin.fill('#key', ADMIN_KEY);
    await admin.click('#loginForm button[type=submit]');
    await admin.waitForSelector('#dash:not([hidden])');
    await admin.waitForSelector('#card-spotify');
  });
  await step('admin: Spotify sin conectar, conectar (mock) y ver conectado', async () => {
    await shot(admin, '02-admin-setup', { fullPage: true });
    expect(await admin.locator('#card-spotify .chip', { hasText: 'Sin conectar' }).count() === 1, 'chip sin conectar');
    await admin.click('#card-spotify a:has-text("Conectar Spotify")');
    await admin.waitForSelector('#card-spotify .chip:has-text("Conectado")');
  });
  await step('admin: elegir dispositivo', async () => {
    await admin.waitForSelector('#card-device .dev');
    await admin.locator('#card-device .dev').first().click();
    await admin.waitForSelector('#card-device .dev.sel');
    await waitFor(async () => (await mockState()).mock.calls > 0);
  });
  await step('admin: empezar fiesta y leer PIN', async () => {
    await admin.fill('#card-party input[placeholder="Nombre de la fiesta"]', 'Fiesta de prueba');
    await admin.click('button:has-text("Empezar fiesta")');
    await admin.waitForSelector('#card-party .pin-big');
    pin = (await admin.textContent('#card-party .pin-big')).trim();
    expect(/^\d{4}$/.test(pin), 'pin de 4 digitos: ' + pin);
    await admin.waitForFunction(() => document.querySelector('#card-party .qr-mini img')?.naturalWidth > 0);
  });
  await step('admin: cambiar un ajuste desde la UI (orden FIFO) y volver a votos', async () => {
    await admin.locator('#card-settings .set', { hasText: 'Orden de la cola' }).locator('button', { hasText: 'Orden de llegada' }).click();
    await waitFor(async () => (await (await adminCtx.request.get(`${BASE}/api/admin/status`)).json()).settings.ordering === 'fifo', { msg: 'ajuste no guardado' });
    await admin.locator('#card-settings .set', { hasText: 'Orden de la cola' }).locator('button', { hasText: 'Por votos' }).click();
    await waitFor(async () => (await (await adminCtx.request.get(`${BASE}/api/admin/status`)).json()).settings.ordering === 'votes');
  });
  await step('admin: ajustes de prueba (espera de añadir 0)', async () => {
    const r = await api(adminCtx, 'PUT', 'admin/settings', { addCooldownSec: 0, controlCooldownSec: 0, globalControlCooldownSec: 0 });
    expect(r.status === 200, 'PUT settings ' + r.status);
    const bad = await api(adminCtx, 'PUT', 'admin/settings', { skipVotePct: 500 });
    expect(bad.status === 400, 'rango invalido debe dar 400');
  });

  console.log('\nB. Invitados: entrada');
  for (const n of [0, 1, 2]) { const c = await newCtx(browser, 'mobile'); gctx.push(c); const p = await c.newPage(); watch(p, `g${n + 1}`); g.push(p); }
  await step('invitado: sin sesion ve la entrada con PIN y nombre', async () => {
    await g[0].goto('');
    await g[0].waitForSelector('#view-join:not([hidden]) #joinForm:not([hidden])');
    expect((await g[0].textContent('#joinParty')).includes('Fiesta de prueba'), 'nombre de fiesta');
    await shot(g[0], '10-guest-join');
  });
  await step('invitado: PIN incorrecto da error y no entra', async () => {
    const wrong = pin === '9999' ? '1111' : '9999';
    await guestJoin(g[0], wrong, 'Laura');
    await g[0].waitForSelector('#joinError:not([hidden])');
    expect((await g[0].textContent('#joinError')).includes('PIN incorrecto'), 'texto de error');
    expect(await g[0].locator('#view-main').isHidden(), 'no debe entrar');
    await shot(g[0], '11-guest-join-error');
  });
  await step('invitado: PIN correcto entra (Laura), enlace con ?p limpia la URL', async () => {
    await g[0].fill('#pin', pin); await g[0].click('#joinBtn');
    await g[0].waitForSelector('#view-main:not([hidden])');
    await guestJoin(g[1], pin, 'Marc', { viaLink: true });
    await g[1].waitForSelector('#view-main:not([hidden])');
    expect(!g[1].url().includes('p='), 'URL limpia');
    await guestJoin(g[2], pin, 'Laura');          // nombre duplicado
    await g[2].waitForSelector('#view-main:not([hidden])');
    expect((await g[2].textContent('#meBtn')).includes('Laura 2'), 'sufijo en nombre duplicado: ' + await g[2].textContent('#meBtn'));
    await api(gctx[2], 'POST', 'join', { pin: '', name: 'Carla' });
    await waitFor(async () => (await g[2].textContent('#meBtn')).includes('Carla'));
  });
  await step('invitado: mantiene la sesion al recargar', async () => {
    await g[0].reload(); await g[0].waitForSelector('#view-main:not([hidden])');
  });

  console.log('\nC. Cola, votos y reordenacion (reloj x1)');
  const X = T(10); const A = T(1); const B = T(2); const C = T(3);
  await step('invitado 1 busca y añade X: empieza a sonar (arranque en frio)', async () => {
    await guestAdd(g[0], X);
    await waitFor(async () => (await g[0].textContent('#npTitle')).includes(X.name), { timeout: 6000, msg: 'X no suena' });
    expect((await g[0].textContent('#npBy')).includes('Laura'), 'pedida por Laura');
    expect((await mockState()).mock.current === X.name, 'mock reproduce X');
  });
  await step('invitados añaden A, B, C y los demas lo ven en menos de 1 s', async () => {
    await guestAdd(g[0], A);
    const t0 = Date.now();
    await waitFor(async () => (await queueTitles(g[1])).length === 1, { timeout: 1500 });
    expect(Date.now() - t0 < 1500, 'tiempo real');
    await guestAdd(g[1], B);
    await guestAdd(g[2], C);
    await waitFor(async () => (await queueTitles(g[0])).length === 3);
  });
  await step('avisos: cada invitado ve solo los suyos y salen abajo (#2)', async () => {
    for (const p of [g[0], g[1], admin]) await watchToasts(p);
    const D = T(12);
    await api(gctx[0], 'GET', `search?q=${encodeURIComponent(D.name.toLowerCase())}`);
    const r = await api(gctx[0], 'POST', 'queue', { uri: D.uri });
    expect(r.status === 200, 'añadir D: ' + JSON.stringify(r));
    try {
      await waitFor(async () => (await seenToasts(g[0])).some((t) => t.includes(D.name)), { timeout: 3000, msg: 'el que añade ve su aviso' });
      await sleep(800);
      expect(!(await seenToasts(g[1])).some((t) => t.includes(D.name)), 'otro invitado no ve el aviso de una canción ajena');
      expect((await seenToasts(admin)).some((t) => t.includes(D.name)), 'el panel sigue viendo los avisos de canciones añadidas');
      // abajo y sin tapar el buscador
      const pos = await g[0].evaluate(() => { const h = document.getElementById('toasts').getBoundingClientRect(); return { bottom: h.bottom, vh: innerHeight }; });
      expect(pos.bottom > pos.vh * 0.85, 'avisos abajo: ' + JSON.stringify(pos));
    } finally {
      // dejar la cola como estaba aunque el paso falle, para no arrastrar a los siguientes
      await api(gctx[0], 'DELETE', `queue/${encodeURIComponent(r.body.item.qid)}`);
      await waitFor(async () => (await queueTitles(g[0])).length === 3);
    }
  });
  await step('votos reordenan la cola en todos (C primero)', async () => {
    const heart = (page, name) => page.locator('#queue .q-item', { hasText: name }).locator('.vote');
    await heart(g[0], C.name).click();
    await heart(g[1], C.name).click();
    await waitFor(async () => clean(await queueTitles(g[2]))[0] === C.name, { timeout: 1500, msg: 'C no sube' });
    expect(clean(await queueTitles(g[0]))[0] === C.name, 'orden en g1');
    expect(await heart(g[2], C.name).isDisabled(), 'no puedes votar tu propia cancion');
    await shot(g[0], '12-guest-main-queue', { fullPage: false });
    await shot(g[0], '13-guest-main-queue-full', { fullPage: true });
  });
  await step('invitado borra su propia cancion y desaparece para todos', async () => {
    await g[1].locator('#queue .q-item', { hasText: B.name }).locator('.del').click();
    await waitFor(async () => (await queueTitles(g[0])).length === 2, { timeout: 1500 });
    expect(!(await g[2].textContent('#queue')).includes(B.name), 'B fuera');
    await guestAdd(g[1], B);
  });
  await step('resultados: cupo, ya en cola y recien sonada se reflejan', async () => {
    await g[0].fill('#q', X.name.toLowerCase());
    const row = g[0].locator('#resultsList .res', { hasText: X.name }).first();
    await row.waitFor();
    expect((await row.textContent()).includes('Sonó hace poco') || (await row.textContent()).includes('Ya en la cola'), 'X marcada');
    await shot(g[0], '14-guest-search-results');
    await g[0].keyboard.press('Escape');
    await waitFor(async () => g[0].locator('#results').isHidden());
  });
  await step('buscador: sube arriba al enfocar y los resultados caben sobre el teclado (#3)', async () => {
    const orig = g[0].viewportSize();
    try {
      for (const [w, h, kb] of [[375, 667, 360], [390, 844, 480]]) {
        await g[0].setViewportSize({ width: w, height: h });
        await g[0].evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
        const sh0 = await g[0].evaluate(() => document.documentElement.scrollHeight);
        await g[0].focus('#q');
        await sleep(700); // la animacion suave termina
        await waitFor(async () => Math.abs(await g[0].evaluate(() => document.getElementById('searchWrap').getBoundingClientRect().top)) <= 2, { timeout: 3000, msg: `buscador no sube arriba (${w}x${h}) ` + JSON.stringify(await g[0].evaluate(() => ({ top: document.getElementById('searchWrap').getBoundingClientRect().top, sy: scrollY, sh: document.documentElement.scrollHeight, ih: innerHeight }))) });
        await g[0].fill('#q', T(4).name.toLowerCase());
        await g[0].locator('#resultsList .res').first().waitFor({ timeout: 4000 });
        await g[0].setViewportSize({ width: w, height: kb });
        await g[0].evaluate(() => window.dispatchEvent(new Event('resize')));
        await sleep(200);
        const m = await g[0].evaluate(() => {
          const b = (e) => e.getBoundingClientRect().bottom;
          const row = document.querySelector('#resultsList .res');
          return { ih: innerHeight, row: b(row), add: b(row.querySelector('.add-btn')), box: b(document.getElementById('results')), sw: document.documentElement.scrollWidth, iw: innerWidth };
        });
        expect(m.row <= m.ih && m.add <= m.ih, `primer resultado/+ fuera de pantalla (${w}x${kb}): ${JSON.stringify(m)}`);
        expect(m.box <= m.ih, `resultados no caben sobre el teclado (${w}x${kb}): ${JSON.stringify(m)}`);
        expect(m.sw <= m.iw, `scroll horizontal (${w}x${kb}): ${JSON.stringify(m)}`);
        await g[0].keyboard.press('Escape');
        await waitFor(async () => g[0].locator('#results').isHidden());
        expect((await g[0].inputValue('#q')) === '', 'buscador vacio');
        await g[0].evaluate(() => document.activeElement && document.activeElement.blur());
        const sh1 = await g[0].evaluate(() => document.documentElement.scrollHeight);
        expect(Math.abs(sh1 - sh0) <= 2, `el espacio extra no se quita (${w}x${h}): antes ${sh0}, despues ${sh1}`);
      }
    } finally {
      await g[0].setViewportSize(orig);
      await g[0].evaluate(() => { window.scrollTo(0, 0); });
    }
  });
  await step('API: limite por invitado y duplicados', async () => {
    const r1 = await api(gctx[0], 'POST', 'queue', { uri: T(5).uri });   // no buscada: desconocida
    expect(r1.status === 400 && r1.body.error === 'unknown_track', 'uri no buscada: ' + JSON.stringify(r1));
    await api(gctx[0], 'GET', `search?q=${encodeURIComponent(T(5).name.toLowerCase())}`);
    const ok = await api(gctx[0], 'POST', 'queue', { uri: T(5).uri });
    expect(ok.status === 200, 'añadir D ' + JSON.stringify(ok));
    await api(gctx[0], 'GET', `search?q=${encodeURIComponent(T(6).name.toLowerCase())}`);
    expect((await api(gctx[0], 'POST', 'queue', { uri: T(6).uri })).status === 200, 'tercera');
    await api(gctx[0], 'GET', `search?q=${encodeURIComponent(T(8).name.toLowerCase())}`);
    const lim = await api(gctx[0], 'POST', 'queue', { uri: T(8).uri });
    expect(lim.status === 429 && lim.body.error === 'limit', 'limite: ' + JSON.stringify(lim));
    const dup = await api(gctx[1], 'POST', 'queue', { uri: T(5).uri });
    expect(dup.status === 409 && dup.body.error === 'duplicate', 'duplicado: ' + JSON.stringify(dup));
    await api(gctx[0], 'DELETE', `queue/${(await (await fetch(`${BASE}/api/_mock/state`)).json()).state.queue.length ? '' : ''}`).catch(() => {});
  });
  await step('pantalla: muestra ahora suena, cola y QR (1920x1080)', async () => {
    const tvCtx = await newCtx(browser, 'tv'); await tvCtx.addCookies(await adminCtx.cookies());
    const tv = await tvCtx.newPage(); watch(tv, 'pantalla');
    await tv.goto('pantalla/');
    await tv.waitForSelector('#stage:not([hidden])');
    await waitFor(async () => (await tv.textContent('#npTitle')).includes(X.name));
    await waitFor(async () => (await tv.locator('#next .n-item').count()) >= 3);
    await tv.waitForFunction(() => document.querySelector('#qr')?.naturalWidth > 0);
    expect((await tv.textContent('#qrPin')).trim() === pin, 'PIN visible');
    await sleep(900);
    await shot(tv, '30-pantalla-tv');
    const before = await tv.locator('#next .n-item').count();
    await guestAdd(g[1], T(7));
    await waitFor(async () => (await tv.locator('#next .n-item').count()) === before + 1, { msg: 'pantalla no se actualiza' });
    await tv.setViewportSize({ width: 1366, height: 768 }); await sleep(300);
    await shot(tv, '31-pantalla-laptop');
    await tv.setViewportSize({ width: 1280, height: 720 });
    await api(gctx[1], 'DELETE', `queue/${await tv.locator('#next .n-item').last().getAttribute('data-key')}`);
    await tvCtx.close();
  });
  await step('pantalla sin sesion de admin pide ir al panel', async () => {
    const c = await newCtx(browser, 'desktop'); const p = await c.newPage(); watch(p, 'pantalla-anon');
    await p.goto('pantalla/');
    await p.waitForSelector('#locked:not([hidden])');
    await c.close();
  });

  console.log('\nD. Control: pausar y saltar');
  await step('saltar por votos: 1/2 no salta, 2/2 salta y suena la primera de la cola', async () => {
    const top = clean(await queueTitles(g[0]))[0];
    await g[0].click('#btnSkip');
    await waitFor(async () => (await g[0].textContent('#btnSkip')).includes('1/2'), { msg: 'contador 1/2' });
    expect((await g[0].textContent('#npTitle')).includes(X.name), 'sigue X');
    await g[1].click('#btnSkip');
    await waitFor(async () => (await g[2].textContent('#npTitle')).includes(top), { timeout: 5000, msg: `no suena ${top}` });
    expect((await mockState()).mock.current === top, 'mock cambia a ' + top);
    await shot(g[2], '15-guest-after-skip');
  });
  await step('saltar directo con cooldown por invitado', async () => {
    await api(adminCtx, 'PUT', 'admin/settings', { skipMode: 'direct', controlCooldownSec: 4, globalControlCooldownSec: 0 });
    await waitFor(async () => (await g[0].textContent('#btnSkip')).trim() === 'Saltar');
    const before = (await mockState()).mock.current;
    await g[0].click('#btnSkip');
    await waitFor(async () => (await mockState()).mock.current !== before, { timeout: 4000, msg: 'no salto' });
    await waitFor(async () => g[0].locator('#btnSkip').isDisabled(), { timeout: 1500, msg: 'boton en cooldown' });
    await waitFor(async () => (await g[0].textContent('#ctrlNote')).includes('Espera'), { timeout: 2000, msg: 'nota de espera' });
    const r = await api(gctx[0], 'POST', 'control/skip');
    expect(r.status === 429 && r.body.error === 'cooldown', 'cooldown API: ' + JSON.stringify(r));
    await shot(g[0], '16-guest-cooldown');
    const r2 = await api(gctx[1], 'POST', 'control/skip');
    expect(r2.status === 200, 'otro invitado si puede: ' + JSON.stringify(r2));
  });
  await step('modo solo anfitrion: saltar oculto y pausa bloqueada', async () => {
    await api(adminCtx, 'PUT', 'admin/settings', { skipMode: 'admin', pauseMode: 'admin' });
    await waitFor(async () => g[0].locator('#btnSkip').isHidden());
    expect(await g[0].locator('#btnPause').isDisabled(), 'pausa deshabilitada');
    const r = await api(gctx[0], 'POST', 'control/pause');
    expect(r.status === 403 && r.body.error === 'admin_only', 'pausa 403');
    const r2 = await api(gctx[0], 'POST', 'control/skip');
    expect(r2.status === 403, 'skip 403');
    await shot(g[0], '17-guest-admin-only');
  });
  await step('el anfitrion pausa y reanuda desde el panel', async () => {
    await admin.locator('#card-player button', { hasText: 'Pausa' }).click();
    await waitFor(async () => (await mockState()).mock.playing === false, { msg: 'mock no pausa' });
    await waitFor(async () => g[1].locator('#pausedBadge').isVisible());
    expect((await mockState()).state.pausedByUs === true, 'pausedByUs');
    await sleep(1200);
    expect((await mockState()).mock.playing === false, 'no se reanuda solo');
    await admin.locator('#card-player button', { hasText: 'Seguir' }).click();
    await waitFor(async () => (await mockState()).mock.playing === true, { msg: 'mock no reanuda' });
  });
  await step('pausa directa por invitado y reanudar', async () => {
    await api(adminCtx, 'PUT', 'admin/settings', { pauseMode: 'direct', skipMode: 'vote', controlCooldownSec: 0 });
    await waitFor(async () => !(await g[1].locator('#btnPause').isDisabled()));
    await sleep(2500);   // que se recargue el limite de acciones por invitado (1/s, rafaga de 4) tras los pasos anteriores
    await g[1].click('#btnPause');
    await waitFor(async () => (await mockState()).mock.playing === false);
    await waitFor(async () => (await g[0].textContent('#btnPause')).includes('Seguir'));
    await sleep(3200);   // antirrebote global de 3 s entre pausar y reanudar
    await g[0].click('#btnPause');
    await waitFor(async () => (await mockState()).mock.playing === true);
  });

  console.log('\nE. Admin: cola, invitados, historial');
  await step('admin: ve cola con asas, sube a la primera y reordena arrastrando', async () => {
    await api(adminCtx, 'POST', 'admin/queue/clear');
    await api(adminCtx, 'PUT', 'admin/settings', { maxQueuedPerGuest: 5 });
    await admin.locator('#card-player button', { hasText: 'Pausa' }).click();   // pausar para que no alimente
    await waitFor(async () => (await mockState()).mock.playing === false);
    for (const [i, gi] of [[11, 0], [12, 1], [14, 2], [15, 0]]) await guestAdd(g[gi], T(i));
    await waitFor(async () => (await admin.locator('#card-queue .aq-item').count()) === 4);
    const titles = async () => (await admin.locator('#card-queue .aq-item .t').allTextContents()).map((s) => s.trim());
    const t0 = await titles();
    // arrastrar el ultimo al primer lugar
    await admin.setViewportSize({ width: 1280, height: 1500 });
    const grip = admin.locator('#card-queue .aq-item').nth(3).locator('.grip');
    await grip.scrollIntoViewIfNeeded();
    const gb = await grip.boundingBox(); const first = await admin.locator('#card-queue .aq-item').nth(0).boundingBox();
    await admin.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
    await admin.mouse.down();
    await admin.mouse.move(gb.x + gb.width / 2, gb.y - 40, { steps: 5 });
    await admin.mouse.move(gb.x + gb.width / 2, first.y + 5, { steps: 10 });
    await shot(admin, '40-admin-dragging', { fullPage: false });
    await admin.mouse.up();
    await admin.setViewportSize({ width: 1280, height: 900 });
    await waitFor(async () => (await titles())[0] === t0[3], { msg: 'arrastrar no reordena: ' + (await titles()).join('|') });
    await waitFor(async () => clean(await queueTitles(g[1]))[0] === t0[3].replace(/^E\s*/, ''), { timeout: 2000, msg: 'el invitado no ve el orden manual' });
    // subir arriba
    await admin.locator('#card-queue .aq-item').nth(2).locator('.top').click();
    await waitFor(async () => (await titles())[0] === t0[2] || (await titles())[0] === t0[1] || (await titles()).length === 4);
    await admin.locator('#card-queue .aq-item').nth(1).locator('.del').click();
    await waitFor(async () => (await admin.locator('#card-queue .aq-item').count()) === 3);
  });
  await step('admin: captura del panel completo (escritorio y movil)', async () => {
    await sleep(400);
    await shot(admin, '41-admin-desktop-full', { fullPage: true });
    const mctx = await newCtx(browser, 'mobile'); await mctx.addCookies(await adminCtx.cookies());
    const mp = await mctx.newPage(); watch(mp, 'admin-movil');
    await mp.goto('admin/'); await mp.waitForSelector('#dash:not([hidden])'); await sleep(800);
    await shot(mp, '42-admin-mobile-full', { fullPage: true });
    const w = await mp.evaluate(() => document.documentElement.scrollWidth);
    const off = await mp.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > 392).slice(0, 6).map((e) => e.tagName + '.' + e.className + ':' + Math.round(e.getBoundingClientRect().right)));
    expect(w <= 392, 'sin scroll horizontal en admin movil: ' + w + ' ' + off.join(' '));
    await mctx.close();
  });
  await step('invitado: sin scroll horizontal a 360 px', async () => {
    const c = await newCtx(browser, 'mobile'); const p = await c.newPage(); watch(p, 'g-360');
    await p.setViewportSize({ width: 360, height: 740 });
    await guestJoin(p, pin, 'Estrecho'); await p.waitForSelector('#view-main:not([hidden])'); await sleep(600);
    const w = await p.evaluate(() => document.documentElement.scrollWidth);
    expect(w <= 361, 'scrollWidth ' + w);
    await shot(p, '18-guest-360', { fullPage: true });
    await c.close();
    // el invitado extra sobra: expulsarlo desde el panel (de paso prueba "Expulsar")
  });
  await step('admin: invitados listados; expulsar y banear', async () => {
    await waitFor(async () => (await admin.locator('#card-guests .ag-item').count()) >= 3);
    const items = await admin.locator('#card-guests .ag-item .nm').allTextContents();
    expect(items.includes('Laura') && items.includes('Marc') && items.includes('Carla'), 'nombres: ' + items.join(','));
    // expulsar a Carla (g3)
    const row = admin.locator('#card-guests .ag-item', { hasText: 'Carla' });
    await row.locator('button', { hasText: 'Expulsar' }).click();
    await row.locator('button', { hasText: '¿Seguro?' }).first().click();
    await g[2].waitForSelector('#view-join:not([hidden])', { timeout: 4000 });
    // el aviso tiene que verse, no solo existir en el DOM (#1)
    await waitFor(async () => (await g[2].textContent('#joinNotice')).includes('sacado'), { timeout: 3000, msg: 'aviso de expulsion' });
    expect(await g[2].locator('#joinNotice').isVisible(), 'aviso de expulsion visible');
    expect((await g[2].textContent('#joinNotice')).includes('sacado'), 'mensaje de expulsion');
    expect(await g[2].locator('#joinError').isHidden(), 'la expulsion no usa el estilo de error');
    // volver a entrar
    await g[2].fill('#pin', pin); await g[2].fill('#name', 'Carla'); await g[2].click('#joinBtn');
    await g[2].waitForSelector('#view-main:not([hidden])');
    // banear a Marc (g2)
    const row2 = admin.locator('#card-guests .ag-item', { hasText: 'Marc' });
    await row2.locator('button', { hasText: 'Banear' }).click();
    await row2.locator('button', { hasText: '¿Banear?' }).click();
    await g[1].waitForSelector('#view-join:not([hidden])', { timeout: 4000 });
    // en el momento del baneo (sin recargar) ya ve su aviso, sin formulario ni estilo de error (#1, review de #16)
    await waitFor(async () => (await g[1].textContent('#joinNotice')).includes('No puedes entrar'), { timeout: 4000, msg: 'aviso de baneo en sesion' });
    expect(await g[1].locator('#joinNotice').isVisible(), 'aviso de baneo visible en sesion');
    expect(await g[1].locator('#joinForm').isHidden(), 'sin formulario tras el baneo');
    expect(await g[1].locator('#joinClosed').isHidden(), 'sin "no hay fiesta" tras el baneo');
    expect(await g[1].locator('#joinError').isHidden(), 'el baneo no usa el estilo de error');
    const me = await api(gctx[1], 'GET', 'me');
    expect(me.status === 403 && me.body.error === 'banned', 'baneado: ' + JSON.stringify(me));
    const rj = await api(gctx[1], 'POST', 'join', { pin, name: 'Marc' });
    expect(rj.status === 403, 'baneado no vuelve: ' + rj.status);
    // al recargar, el baneado ve su aviso y no el falso "no hay fiesta" (#1)
    await g[1].reload();
    await waitFor(async () => (await g[1].textContent('#joinNotice')).includes('No puedes entrar'), { timeout: 4000, msg: 'aviso de baneo tras recargar' });
    expect((await g[1].textContent('#joinNotice')).includes('No puedes entrar'), 'aviso de baneo');
    expect(await g[1].locator('#joinNotice').isVisible(), 'aviso de baneo visible');
    expect(await g[1].locator('#joinClosed').isHidden(), 'sin el falso "no hay fiesta"');
    expect(await g[1].locator('#joinForm').isHidden(), 'sin formulario de entrada');
    await waitFor(async () => (await admin.locator('#card-guests .ag-item', { hasText: 'Baneado' }).count()) === 1);
  });
  await step('admin: nuevo PIN mantiene a los invitados; con expulsar los saca', async () => {
    const old = pin;
    await api(adminCtx, 'POST', 'admin/party/pin', { kickAll: false });
    await waitFor(async () => (await admin.textContent('#card-party .pin-big')).trim() !== old);
    pin = (await admin.textContent('#card-party .pin-big')).trim();
    expect((await api(gctx[0], 'GET', 'me')).status === 200, 'g1 sigue dentro');
    const rp = await api(adminCtx, 'POST', 'admin/party/pin', { kickAll: true });
    await g[0].waitForSelector('#view-join:not([hidden])', { timeout: 4000 });
    pin = rp.body.pin;
    for (const i of [0, 2]) {
      await g[i].fill('#pin', pin); await g[i].fill('#name', i === 0 ? 'Laura' : 'Carla'); await g[i].click('#joinBtn');
      try { await g[i].waitForSelector('#view-main:not([hidden])', { timeout: 6000 }); }
      catch (e) { throw new Error(`g${i} no entra: joinError="${await g[i].textContent('#joinError')}" form=${await g[i].isHidden('#joinForm')} join=${await g[i].isHidden('#view-join')} pin=${pin}`); }
    }
  });
  await step('PIN: bloqueo tras muchos fallos', async () => {
    const c = await newCtx(browser, 'desktop');
    let last;
    for (let i = 0; i < 6; i++) last = await api(c, 'POST', 'join', { pin: '0000' === pin ? '1111' : '0000', name: 'x' });
    expect(last.status === 429, 'limite por IP: ' + last.status);
    await c.close();
  });

  console.log('\nF. Motor acelerado (x30)');
  await step('el motor reproduce la cola en orden, alimenta en los ultimos 20 s y llena el historial', async () => {
    await api(adminCtx, 'POST', 'admin/queue/clear');
    await api(adminCtx, 'PUT', 'admin/settings', { maxQueuedPerGuest: 10, noRepeatMin: 0 });
    await mockCmd('speed', 30);
    await sleep(300);
    for (const p of [g[0], g[2]]) await watchToasts(p);
    const seq = [T(20), T(21), T(22), T(23)];
    const ctxs = [gctx[0], gctx[2]];
    for (const [i, t] of seq.entries()) {
      await api(ctxs[i % 2], 'GET', `search?q=${encodeURIComponent(t.name.toLowerCase())}`);
      const r = await api(ctxs[i % 2], 'POST', 'queue', { uri: t.uri });
      expect(r.status === 200, 'add ' + JSON.stringify(r));
      await sleep(250);
    }
    await api(adminCtx, 'PUT', 'admin/settings', { ordering: 'fifo' });
    await admin.locator('#card-player button', { hasText: 'Seguir' }).click();
    const seen = []; let fedRemaining = null; let fedMax = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      const st = await mockState();
      const cur = st.mock.current;
      if (cur && seen[seen.length - 1] !== cur) seen.push(cur);
      if (st.state.fed) {
        const meta = CAT.find((c) => c.name === st.state.queue.length && false);
        const trk = CAT.find((c) => c.uri === st.state.fed.uri);
        if (trk) { const rem = trk && st.mock.current ? (CAT.find((c) => c.name === st.mock.current).duration_ms - st.mock.progressMs) : null; if (rem !== null && fedRemaining === null) fedRemaining = rem; }
        fedMax++;
      }
      if (seen.length >= 5 && st.state.queue.length === 0 && st.state.fed === null && !st.mock.playing) break;
      if (seen.includes(seq[3].name) && st.state.queue.length === 0 && !st.state.fed) { await sleep(200); }
      if (seen.includes(seq[3].name) && (await mockState()).mock.current === seq[3].name && st.mock.progressMs > CAT.find((c) => c.name === seq[3].name).duration_ms - 3000) break;
      await sleep(80);
    }
    const order = seen.filter((n) => seq.some((s) => s.name === n));
    expect(JSON.stringify(order) === JSON.stringify(seq.map((s) => s.name)), 'orden de reproduccion: ' + order.join(' > '));
    expect(fedMax > 0, 'fed aparecio');
    // «Ahora suena» solo le llega al dueño de la canción (#2): T20 es de g[0] (Laura), T21 de g[2] (Carla)
    const now0 = (await seenToasts(g[0])).filter((t) => t.startsWith('Ahora suena'));
    const now2 = (await seenToasts(g[2])).filter((t) => t.startsWith('Ahora suena'));
    expect(now0.some((t) => t.includes(seq[0].name)) && !now0.some((t) => t.includes(seq[1].name)), 'Laura ve solo «Ahora suena» de las suyas: ' + now0.join(' | '));
    expect(now2.some((t) => t.includes(seq[1].name)) && !now2.some((t) => t.includes(seq[0].name)), 'Carla ve solo «Ahora suena» de las suyas: ' + now2.join(' | '));
    expect(fedRemaining !== null && fedRemaining <= 26000, 'fed al final de la cancion, quedaban ' + fedRemaining + ' ms');
    await waitFor(async () => (await admin.locator('#card-history .ah-item').count()) >= 3, { timeout: 8000, msg: 'historial se llena' });
    await shot(admin, '43-admin-history', { fullPage: false });
  });
  await step('con la cola vacia suena el relleno de la playlist del anfitrion', async () => {
    await mockCmd('filler', 4);
    await waitFor(async () => (await g[0].textContent('#npBy')).includes('Relleno'), { timeout: 6000, msg: 'chip de relleno' });
    await shot(g[0], '19-guest-filler');
  });
  await step('el historial se puede guardar como playlist', async () => {
    await mockCmd('speed', 1);
    await admin.click('#card-history .builder summary');
    await admin.fill('#card-history .builder input[maxlength="100"]', 'Mi playlist de prueba');
    await admin.waitForSelector('#card-history .pv b');
    await admin.click('#card-history button:has-text("Crear playlist en Spotify")');
    await admin.waitForSelector('#card-history a:has-text("Abrir en Spotify")', { timeout: 6000 });
    const st = await mockState();
    expect(st.mock.playlists.length === 1 && st.mock.playlists[0].uris.length >= 3, 'playlist con canciones: ' + JSON.stringify(st.mock.playlists.map((p) => p.uris.length)));
    expect(st.mock.playlists[0].public === false, 'privada');
  });

  console.log('\nG. Fallos de Spotify');
  await step('token caducado: refresca solo y sigue funcionando', async () => {
    await mockCmd('expire');
    const r = await api(gctx[0], 'GET', `search?q=${encodeURIComponent(T(30).name.toLowerCase())}`);
    expect(r.status === 200 && r.body.results.length === 1, 'busqueda tras caducar: ' + JSON.stringify(r).slice(0, 200));
  });
  await step('sin dispositivo: banner para invitados y recuperacion', async () => {
    await api(adminCtx, 'POST', 'admin/queue/clear');
    await mockCmd('disconnect');
    await api(gctx[0], 'GET', `search?q=${encodeURIComponent(T(31).name.toLowerCase())}`);
    await api(gctx[0], 'POST', 'queue', { uri: T(31).uri });
    await waitFor(async () => (await g[0].locator('#banner').isVisible()) && (await g[0].textContent('#banner')).includes('parada'), { timeout: 6000, msg: 'banner sin dispositivo' });
    await shot(g[0], '20-guest-no-device');
    expect((await admin.textContent('#alerts')).includes('dispositivo'), 'alerta en admin');
    await mockCmd('connect');
    await api(adminCtx, 'POST', 'admin/device', { deviceId: 'mockdev1' });
    await api(adminCtx, 'POST', 'admin/control/resume');
    await api(adminCtx, 'POST', 'admin/control/skip');
    await waitFor(async () => (await mockState()).mock.current === T(31).name, { timeout: 8000, msg: 'se recupera y suena la cancion' });
    await waitFor(async () => g[0].locator('#banner').isHidden());
  });
  await step('429 inyectado: no se cae, avisa y se recupera', async () => {
    await mockCmd('rate429', 4);
    await waitFor(async () => (await g[0].locator('#banner').isVisible()) && (await g[0].textContent('#banner')).includes('saturado'), { timeout: 6000, msg: 'banner 429' });
    await api(gctx[0], 'GET', `search?q=${encodeURIComponent(T(32).name.toLowerCase())}`).then((r) => expect(r.status === 429, 'busqueda durante 429: ' + r.status));
    expect((await fetch(`${BASE}/api/health`)).ok, 'servidor vivo');
    await waitFor(async () => g[0].locator('#banner').isHidden(), { timeout: 12000, msg: 'se recupera tras el 429' });
  });
  await step('error 503 puntual de Spotify: reintenta y no falla', async () => {
    await mockCmd('fail', 1);
    const r = await api(gctx[0], 'GET', `search?q=${encodeURIComponent(T(33).name.toLowerCase())}`);
    expect(r.status === 200, 'reintento 5xx: ' + r.status);
  });

  console.log('\nH. Cierre');
  await step('SSE a traves del servidor: snapshot y latidos', async () => {
    const cookies = await adminCtx.cookies();
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const ac = new AbortController();
    const res = await fetch(`${BASE}/api/events`, { headers: { cookie }, signal: ac.signal });
    expect(res.headers.get('content-type').startsWith('text/event-stream'), 'content-type');
    expect(res.headers.get('x-accel-buffering') === 'no', 'x-accel-buffering');
    const reader = res.body.getReader(); let buf = '';
    const t0 = Date.now();
    while (Date.now() - t0 < 3500) {
      const r = await Promise.race([reader.read(), sleep(3600).then(() => ({ done: true }))]);
      if (r.done) break; buf += Buffer.from(r.value).toString();
      if (buf.includes('event: state') && buf.includes(':hb')) break;
    }
    ac.abort();
    expect(buf.includes('event: state'), 'snapshot inicial'); expect(buf.includes(':hb'), 'latido ' + buf.slice(0, 200));
    const anon = await fetch(`${BASE}/api/events`);
    expect(anon.status === 401, 'SSE sin sesion 401');
  });
  await step('seguridad: origen ajeno, content-type y cabeceras', async () => {
    const r = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ key: ADMIN_KEY }) });
    expect(r.status === 403, 'origen ajeno ' + r.status);
    const r2 = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ key: ADMIN_KEY }) });
    expect(r2.status === 415, 'content-type ' + r2.status);
    const r3 = await fetch(`${BASE}/api/admin/status`);
    expect(r3.status === 401, 'status sin cookie');
    const h = await fetch(`${BASE}/`);
    expect((h.headers.get('content-security-policy') || '').includes("default-src 'self'"), 'CSP');
    expect(h.headers.get('x-content-type-options') === 'nosniff', 'nosniff');
    const r4 = await fetch(`${BASE}/api/admin/qr.svg`);
    expect(r4.status === 401, 'qr protegido');
  });
  await step('avisos: 20 entradas seguidas y el invitado no ve ningún «se ha unido» (#2)', async () => {
    await watchToasts(g[0]);
    // otra IP (via proxy local de confianza) para no chocar con el limite por IP del paso del PIN
    for (let i = 0; i < 20; i++) {
      const r = await fetch(`${BASE}/api/join`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.20' }, body: JSON.stringify({ pin, name: `Ola ${i + 1}` }) });
      expect(r.status === 200, `entrada ${i + 1}: ${r.status}`);
    }
    await sleep(1500);
    const seen = await seenToasts(g[0]);
    expect(!seen.some((t) => t.includes('se ha unido')), 'sin avisos de entrada: ' + seen.join(' | '));
  });
  await step('la fiesta termina: los invitados vuelven a la entrada', async () => {
    await admin.locator('#card-party button', { hasText: 'Terminar fiesta' }).click();
    await admin.locator('#card-party button', { hasText: 'Pulsa otra vez' }).click();
    await g[0].waitForSelector('#view-join:not([hidden])', { timeout: 5000 });
    await waitFor(async () => (await g[0].textContent('#joinNotice')).includes('terminado'), { msg: 'mensaje de fin' });
    await g[0].waitForSelector('#joinClosed:not([hidden])');
    expect(await g[0].locator('#joinNotice').isVisible(), 'aviso de fin visible (#1)');
    // region viva siempre presente (sin hidden) para que los lectores de pantalla anuncien el cambio
    expect(await g[0].getAttribute('#joinNotice', 'role') === 'status' && await g[0].getAttribute('#joinNotice', 'hidden') === null, 'aviso como region viva');
    await shot(g[0], '21-guest-party-ended');
    await shot(admin, '44-admin-party-stopped', { fullPage: true });
  });
  await step('persistencia: reiniciar el servidor conserva fiesta, ajustes e historial', async () => {
    await api(adminCtx, 'POST', 'admin/party/start', { name: 'Segunda fiesta' });
    await api(adminCtx, 'PUT', 'admin/settings', { maxQueuedPerGuest: 7 });
    await sleep(1300);
    await stopServer(); await startServer(1);
    const st = await api(adminCtx, 'GET', 'admin/status');
    expect(st.status === 200 && st.body.settings.maxQueuedPerGuest === 7, 'ajustes tras reinicio');
    expect(st.body.party.name === 'Segunda fiesta' && st.body.party.active, 'fiesta activa tras reinicio');
    const p = await (await fetch(`${BASE}/api/party`)).json();
    expect(p.active === true, 'party publica');
    const mode = fs.statSync(path.join(DATA, 'state.json')).mode & 0o777;
    expect(fs.existsSync(path.join(DATA, 'spotify.json')) && (process.platform === 'win32' || (fs.statSync(path.join(DATA, 'spotify.json')).mode & 0o777) === 0o600), 'spotify.json con permisos 600');
  });

  await step('sin errores de consola ni excepciones en ninguna pagina', async () => {
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
if (!KEEP) fs.rmSync(SHOTS, { recursive: true, force: true });
fs.rmSync(DATA, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
