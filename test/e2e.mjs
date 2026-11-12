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

// ---------- panel: engranajes y historial plegable (#36) ----------
async function openGear(page, card) {
  const b = page.locator(`${card} button.gear`);
  if ((await b.getAttribute('aria-expanded')) !== 'true') await b.click();
  await page.waitForSelector(`${card} .set-panel`, { state: 'visible' });
}
async function openHistory(page) {
  const b = page.locator('#card-history .cmp-toggle');
  if ((await b.getAttribute('aria-expanded')) !== 'true') await b.click();
  await page.waitForSelector('#card-history .hist-body', { state: 'visible' });
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
  window.__toastObs = new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) { if (n.classList?.contains('toast')) window.__toasts.push(n.textContent); else if (n.nodeType === 3) { const t = m.target.closest?.('.toast'); if (t) window.__toasts.push(t.textContent); } } });
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
    if (!(await admin.locator('#card-device .dev').first().isVisible().catch(() => false))) {
      await admin.locator('#card-device .cmp-toggle').click();     // compacta: «Cambiar» despliega la lista
    }
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
    await openGear(admin, '#card-queue');
    await admin.locator('#card-queue .set', { hasText: 'Orden de la cola' }).locator('button', { hasText: 'Orden de llegada' }).click();
    await waitFor(async () => (await (await adminCtx.request.get(`${BASE}/api/admin/status`)).json()).settings.ordering === 'fifo', { msg: 'ajuste no guardado' });
    await admin.locator('#card-queue .set', { hasText: 'Orden de la cola' }).locator('button', { hasText: 'Por votos' }).click();
    await waitFor(async () => (await (await adminCtx.request.get(`${BASE}/api/admin/status`)).json()).settings.ordering === 'votes');
  });
  await step('admin: ajustes de prueba (espera de añadir 0)', async () => {
    const r = await api(adminCtx, 'PUT', 'admin/settings', { addCooldownSec: 0, controlCooldownSec: 0, globalControlCooldownSec: 0 });
    expect(r.status === 200, 'PUT settings ' + r.status);
    const bad = await api(adminCtx, 'PUT', 'admin/settings', { skipVotePct: 500 });
    expect(bad.status === 400, 'rango invalido debe dar 400');
  });
  await step('admin: ajustes en los paneles de Cola e Invitados, condicionales y accesibles', async () => {
    const st = async () => (await api(adminCtx, 'GET', 'admin/status')).body.settings;
    const orig = await st();
    const keys = ['skipMode', 'pauseMode', 'maxQueuedPerGuest', 'skipVoteMode', 'skipVotePct', 'skipVoteFixed'];
    try {
      expect(await admin.locator('#card-settings').count() === 0, 'ya no existe la tarjeta Ajustes');
      await openGear(admin, '#card-queue'); await openGear(admin, '#card-guests');
      const panels = [
        ['#card-queue .set-panel', 'Ajustes de la cola', ['maxQueuedPerGuest', 'addCooldownSec', 'maxDurationMin', 'noRepeatMin'], ['Cola abierta', 'Orden de la cola', 'Permitir canciones explícitas']],
        ['#card-guests .set-panel', 'Ajustes de los invitados', ['skipVotePct', 'skipVoteFixed', 'controlCooldownSec', 'globalControlCooldownSec'], ['Pausar y reanudar', 'Saltar canción']],
      ];
      for (const [sel, label, ids, texts] of panels) {
        const g = admin.locator(sel);
        expect(await g.getAttribute('aria-label') === label, `panel «${label}»`);
        for (const k of ids) expect(await g.locator(`#set-${k}`).count() === 1, `${k} está en «${label}»`);
        for (const l of texts) expect(await g.locator('.set', { hasText: l }).count() >= 1, `«${l}» está en «${label}»`);
      }
      expect(await admin.locator('#card-queue #skipLive').count() === 0 && await admin.locator('#card-guests #skipLive').count() === 1, '#skipLive vive en Invitados');
      const row = (k) => admin.locator(`.set-panel .set:has(#set-${k})`);
      const seg = (label, btn) => admin.locator('.set-panel .set', { hasText: label }).locator('button', { hasText: btn });
      // votos para saltar solo con «Por votos»
      await seg('Saltar canción', 'Por votos').click();
      expect(await admin.locator('#card-guests .set', { hasText: '¿Cuántos votos hacen falta?' }).isVisible(), 'por votos: se ve el selector de modo');
      expect(await admin.locator('.set-panel .set', { hasText: 'Mínimo de votos' }).count() === 0, 'ya no existe «Mínimo de votos»');
      await seg('¿Cuántos votos hacen falta?', 'Parte de la gente').click();
      expect(await row('skipVotePct').isVisible() && !(await row('skipVoteFixed').isVisible()), 'parte de la gente: solo el range de porcentaje');
      const live = admin.locator('#skipLive');
      const liveText = async () => ((await live.textContent()) || '').trim();
      const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;
      // misma frase que el panel en cada caso (sin activos, uno, todos, fijo mayor que los activos o lo normal)
      const liveFor = (needed, active, mode, fixed) => {
        if (active === 0) return 'Ahora no hay invitados activos: con 1 voto se saltaría.';
        if (active === 1) return 'Ahora: basta con el voto del único invitado activo.';
        if (needed >= active) return `Ahora: tienen que votar los ${active} invitados activos${mode === 'fixed' && fixed > active ? ` (pides ${fixed}, pero solo hay ${active})` : ''}.`;
        return `Ahora: ${plural(needed, 'voto', 'votos')} de ${active} invitados activos.`;
      };
      const expectLive = async (what) => {
        await waitFor(async () => {
          const ss = (await api(adminCtx, 'GET', 'admin/status')).body; const cfg = await st();
          return (await liveText()) === liveFor(ss.skipNeeded, ss.activeGuests, cfg.skipVoteMode, cfg.skipVoteFixed);
        }, { msg: `#skipLive no coincide con el servidor (${what}): ${await liveText()}` });
      };
      await expectLive('porcentaje');
      expect(!/\b0 invitados\b/.test(await liveText()) && !/1 voto de 1 invitado/.test(await liveText()), 'frase coherente: ' + await liveText());
      await admin.locator('#set-skipVotePct').fill('100');
      await admin.locator('#set-skipVotePct').dispatchEvent('input');
      await admin.locator('#set-skipVotePct').dispatchEvent('change');
      await waitFor(async () => (await st()).skipVotePct === 100, { msg: 'porcentaje no guardado' });
      await expectLive('100 %');
      await seg('¿Cuántos votos hacen falta?', 'Número fijo').click();
      expect(await row('skipVoteFixed').isVisible() && !(await row('skipVotePct').isVisible()), 'número fijo: solo el range de votos');
      await waitFor(async () => (await st()).skipVoteMode === 'fixed', { msg: 'modo no guardado' });
      await admin.locator('#set-skipVoteFixed').fill('1');
      await admin.locator('#set-skipVoteFixed').dispatchEvent('input');
      const act = (await api(adminCtx, 'GET', 'admin/status')).body.activeGuests;
      expect(await liveText() === liveFor(1, act, 'fixed', 1), 'vista previa inmediata: ' + await liveText());
      await admin.locator('#set-skipVoteFixed').dispatchEvent('change');
      await waitFor(async () => (await st()).skipVoteFixed === 1, { msg: 'fijo no guardado' });
      await expectLive('fijo 1');
      // número fijo mayor que los activos: lo dice en vez de prometer algo imposible
      await admin.locator('#set-skipVoteFixed').fill('20');
      await admin.locator('#set-skipVoteFixed').dispatchEvent('input');
      await admin.locator('#set-skipVoteFixed').dispatchEvent('change');
      await waitFor(async () => (await st()).skipVoteFixed === 20, { msg: 'fijo 20 no guardado' });
      await expectLive('fijo 20');
      if (act >= 2) expect((await liveText()).includes(`(pides 20, pero solo hay ${act})`), 'fijo > activos lo explica: ' + await liveText());
      await seg('Saltar canción', 'Directo').click();
      expect(!(await row('skipVotePct').isVisible()) && !(await row('skipVoteFixed').isVisible()) && !(await live.isVisible()), 'directo: no se ven las filas de votos');
      // esperas solo si alguien puede pausar o saltar directo
      await seg('Pausar y reanudar', 'Solo yo').click();
      await seg('Saltar canción', 'Solo yo').click();
      expect(!(await row('controlCooldownSec').isVisible()) && !(await row('globalControlCooldownSec').isVisible()), 'solo yo: no se ven las esperas');
      await seg('Saltar canción', 'Directo').click();
      expect(await row('controlCooldownSec').isVisible() && await row('globalControlCooldownSec').isVisible(), 'directo: se ven las esperas');
      // salidas accesibles
      const bad = await admin.evaluate(() => [...document.querySelectorAll('.set-panel output')].filter((o) => { const r = document.getElementById(o.getAttribute('for') || ''); return !r || r.type !== 'range'; }).length);
      expect(bad === 0, 'cada output apunta a su range');
      const ranges = await admin.evaluate(() => [...document.querySelectorAll('.set-panel input[type=range]')].map((r) => [r.id, r.getAttribute('aria-valuetext')]));
      expect(ranges.length === 8 && ranges.every(([id, t]) => id && t), 'cada range con aria-valuetext: ' + JSON.stringify(ranges));
      // guardar un range
      const next = orig.maxQueuedPerGuest === 6 ? 7 : 6;
      await watchToasts(admin);
      await admin.locator('#set-maxQueuedPerGuest').fill(String(next));
      await admin.locator('#set-maxQueuedPerGuest').dispatchEvent('change');
      await waitFor(async () => (await seenToasts(admin)).includes('Ajustes guardados'), { msg: 'falta el aviso «Ajustes guardados»' });
      expect((await st()).maxQueuedPerGuest === next, 'el range se guarda');
      expect(await admin.locator('#set-maxQueuedPerGuest').getAttribute('aria-valuetext') === String(next), 'aria-valuetext al día');
      await admin.locator('#card-guests').screenshot({ path: path.join(SHOTS, '62-admin-ajustes.png') });
    } finally {
      await api(adminCtx, 'PUT', 'admin/settings', Object.fromEntries(keys.map((k) => [k, orig[k]])));
    }
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
    expect((await g[0].textContent('#npBy')).includes('La has pedido tú'), 'su propia canción: «La has pedido tú»');
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
    for (const p of [g[0], g[1], g[2], admin]) await watchToasts(p);
    const D = T(12);
    try {
      await guestAdd(g[0], D);
      // #5: quien añade recibe su confirmación con el puesto (y es la única que ve)
      const nD = clean(await queueTitles(g[0])).indexOf(D.name) + 1;
      expect(nD > 0, 'D en la cola de g[0]');
      const want = nD === 1 ? 'Añadida · suena la siguiente' : `Añadida · va la ${nD}.ª`;
      await waitFor(async () => (await seenToasts(g[0])).includes(want), { timeout: 3000, msg: `el que añade ve «${want}»: ` + (await seenToasts(g[0])).join(' | ') });
      await sleep(800);
      for (const [n, p] of [['g1', g[1]], ['g0', g[0]], ['g2', g[2]]]) {
        const seen = await seenToasts(p);
        expect(!seen.some((t) => t.includes('añadió')), `${n} no ve «X añadió …» (#5): ` + seen.join(' | '));
      }
      expect(!(await seenToasts(g[1])).some((t) => t.includes(D.name) || t.startsWith('Añadida')), 'otro invitado no ve el aviso de una canción ajena');
      // el panel agrupa avisos seguidos («X y N más añadieron canciones»): ve el nombre o el aviso agrupado
      // el aviso puede ser uno nuevo o el agrupado que ya estaba en pantalla y se actualiza: se mira lo visto y lo que hay ahora
      const adminToasts = async () => [...(await seenToasts(admin)), ...(await admin.locator('#toasts .toast').allTextContents())];
      await waitFor(async () => (await adminToasts()).some((t) => t.includes(D.name) || /añadi(ó|eron)/.test(t)), { timeout: 5000, msg: 'el panel sigue viendo los avisos de canciones añadidas: ' + (await adminToasts()).join(' | ') });
      // abajo y sin tapar el buscador
      const pos = await g[0].evaluate(() => { const h = document.getElementById('toasts').getBoundingClientRect(); return { bottom: h.bottom, vh: innerHeight }; });
      expect(pos.bottom > pos.vh * 0.85, 'avisos abajo: ' + JSON.stringify(pos));
    } finally {
      // dejar la cola como estaba aunque el paso falle, para no arrastrar a los siguientes
      const del = g[0].locator('#queue .q-item', { hasText: D.name }).locator('.del');
      if (await del.count()) await del.click();
      await waitFor(async () => (await queueTitles(g[0])).length === 3);
    }
  });
  await step('votos reordenan la cola en todos (C primero)', async () => {
    const voteBtn = (page, name) => page.locator('#queue .q-item', { hasText: name }).locator('.vote');
    await voteBtn(g[0], C.name).click();
    await voteBtn(g[1], C.name).click();
    await waitFor(async () => clean(await queueTitles(g[2]))[0] === C.name, { timeout: 1500, msg: 'C no sube' });
    expect(clean(await queueTitles(g[0]))[0] === C.name, 'orden en g1');
    expect(await voteBtn(g[2], C.name).isDisabled(), 'no puedes votar tu propia cancion');
    // #4: en la cola se vota con la flecha (no el corazon) y el boton lo dice
    const vb = await g[1].locator('#queue .q-item', { hasText: A.name }).locator('.vote').evaluate((b) => ({ up: !!b.querySelector('svg path[d="M12 19V5"]'), heart: !!b.querySelector('svg path[d^="M19 14c1.49"]'), label: b.getAttribute('aria-label') }));
    expect(vb.up && !vb.heart, 'el voto de la cola usa la flecha, no el corazon: ' + JSON.stringify(vb));
    expect(/^(Votar|Quitar mi voto)/.test(vb.label), 'aria-label del voto: ' + vb.label);
    expect((await voteBtn(g[2], C.name).getAttribute('aria-label')) === 'Votos a tu canción', 'aria-label de la propia canción');
    // #5: cada invitado ve el puesto de sus canciones, y se actualiza en vivo
    const own = [[g[0], A], [g[1], B], [g[2], C]];
    const posText = async (page, t) => (await page.locator('#queue .q-item', { hasText: t.name }).locator('.q-by').textContent()).trim();
    const expectedPos = async (page, t) => { const n = clean(await queueTitles(page)).indexOf(t.name) + 1; return n === 1 ? 'Tu canción · la siguiente' : `Tu canción · n.º ${n}`; };
    for (const [pg, t] of own) expect((await posText(pg, t)) === (await expectedPos(pg, t)), `puesto de ${t.name}: ${await posText(pg, t)}`);
    expect((await posText(g[2], C)) === 'Tu canción · la siguiente', 'C va la siguiente');
    expect((await posText(g[1], A)).startsWith('de '), 'las ajenas siguen con «de Nombre»')
    // #13: botón del nombre cómodo de pulsar; «Pausa» pesa menos que «Saltar»
    const meH = await g[0].evaluate(() => document.getElementById('meBtn').getBoundingClientRect().height);
    expect(meH >= 44, '#meBtn mide al menos 44px: ' + meH);
    const ctl = await g[0].evaluate(() => {
      const f = (id) => { const b = document.getElementById(id); return { cls: b.className, bg: getComputedStyle(b).backgroundColor, h: b.getBoundingClientRect().height }; };
      return { pause: f('btnPause'), skip: f('btnSkip') };
    });
    expect(/\bsubtle\b/.test(ctl.pause.cls) && !/\bsubtle\b/.test(ctl.skip.cls), 'sonando: Pausa es subtle y Saltar no: ' + JSON.stringify(ctl));
    expect(ctl.pause.bg !== ctl.skip.bg, 'fondos distintos: ' + JSON.stringify(ctl));
    expect(ctl.pause.h >= 44 && ctl.skip.h >= 44, 'ambos >= 44px: ' + JSON.stringify(ctl));
    await shot(g[0], '12-guest-main-queue', { fullPage: false });
    try {
      // B sube con dos votos (empata con C y es mas antigua): B, C, A
      await voteBtn(g[0], B.name).click();
      await voteBtn(g[2], B.name).click();
      await waitFor(async () => clean(await queueTitles(g[1]))[0] === B.name, { timeout: 2500, msg: 'B no sube' });
      await waitFor(async () => (await posText(g[1], B)) === 'Tu canción · la siguiente', { msg: 'B pasa a «la siguiente» en vivo' });
      await waitFor(async () => (await posText(g[2], C)) === 'Tu canción · n.º 2', { msg: 'C baja al 2 en vivo' });
      await waitFor(async () => (await posText(g[0], A)) === 'Tu canción · n.º 3', { msg: 'A baja al 3 en vivo' });
    } finally {
      for (const p of [g[0], g[2]]) {
        const b = voteBtn(p, B.name);
        if ((await b.getAttribute('aria-pressed')) === 'true') await b.click();
      }
      await waitFor(async () => clean(await queueTitles(g[2]))[0] === C.name, { timeout: 2500, msg: 'C vuelve arriba' });
    }

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
    // #4: una sola X, que borra y cierra
    expect((await g[0].locator('#resultsClose').count()) === 0, 'ya no hay segunda X en la cabecera de resultados');
    expect((await g[0].getAttribute('#qClear', 'aria-label')) === 'Borrar y cerrar la búsqueda', 'aria-label de la X');
    await g[0].fill('#q', X.name.toLowerCase());
    await g[0].locator('#resultsList .res', { hasText: X.name }).first().waitFor();
    expect(await g[0].locator('#qClear').isVisible(), 'la X se ve con resultados abiertos');
    await g[0].click('#qClear');
    await waitFor(async () => g[0].locator('#results').isHidden(), { msg: 'la X cierra los resultados' });
    expect((await g[0].inputValue('#q')) === '' && await g[0].locator('#qClear').isHidden(), 'la X borra el texto y se esconde');
  });
  await step('búsqueda fallida: «Reintentar» vuelve a buscar con el mismo término (#13)', async () => {
    const pat = '**/api/search**';
    await g[0].route(pat, (r) => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'unavailable', message: 'Spotify no responde ahora mismo.' }) }));
    try {
      await g[0].fill('#q', X.name.toLowerCase());
      const retry = g[0].locator('#resultsList .res-empty button', { hasText: 'Reintentar' });
      await retry.waitFor({ timeout: 5000 });
      expect((await retry.boundingBox()).height >= 44, '«Reintentar» mide al menos 44px');
      expect((await g[0].textContent('#resultsList .res-empty')).includes('Spotify no responde ahora mismo.'), 'muestra el mensaje de error');
      await g[0].unroute(pat);
      await retry.click();
      await g[0].locator('#resultsList .res', { hasText: X.name }).first().waitFor({ timeout: 5000 });
      expect(await g[0].locator('#results').isVisible(), 'los resultados siguen abiertos tras reintentar');
      expect((await g[0].locator('#resultsList .res-empty').count()) === 0, 'el error desaparece');
    } finally {
      await g[0].unroute(pat).catch(() => {});
    }
    await g[0].click('#qClear');
    await waitFor(async () => g[0].locator('#results').isHidden(), { msg: 'cerrar tras reintentar' });
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
        const pos = () => g[0].evaluate(() => ({ top: document.getElementById('searchWrap').getBoundingClientRect().top, sy: scrollY, sh: document.documentElement.scrollHeight, ih: innerHeight }));
        try {
          await waitFor(async () => Math.abs((await pos()).top) <= 2, { timeout: 3000, msg: 'buscador no sube arriba' });
        } catch (e) { throw new Error(`${e.message} (${w}x${h}) ` + JSON.stringify(await pos())); }
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
      // regresion: con la cola desplazada el buscador ya esta fijo arriba y enfocarlo no debe mover la pagina
      await g[0].setViewportSize({ width: 375, height: 667 });
      await g[0].evaluate(() => {
        document.activeElement?.blur();
        const tall = document.createElement('div'); tall.id = 'e2eTall'; tall.style.height = '1500px';
        document.getElementById('queue').after(tall);
        const a = document.getElementById('searchAnchor').getBoundingClientRect().top + scrollY;
        window.scrollTo({ top: a + 150, behavior: 'instant' });
      });
      await sleep(200);
      const before = await g[0].evaluate(() => scrollY);
      expect((await g[0].evaluate(() => Math.abs(document.getElementById('searchWrap').getBoundingClientRect().top))) <= 2, 'preparacion: buscador deberia estar fijo arriba');
      await g[0].focus('#q');
      await sleep(700);
      const after = await g[0].evaluate(() => ({ sy: scrollY, top: document.getElementById('searchWrap').getBoundingClientRect().top }));
      expect(Math.abs(after.sy - before) <= 2 && Math.abs(after.top) <= 2, `enfocar movio la pagina con la cola desplazada: scrollY ${before} -> ${after.sy}, top ${after.top}`);
    } finally {
      await g[0].setViewportSize(orig);
      await g[0].evaluate(() => { document.getElementById('e2eTall')?.remove(); document.activeElement?.blur(); window.scrollTo(0, 0); });
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
    // #13: sin resumen todavía, las imágenes del resumen no pintan icono roto
    expect(await tv.evaluate(() => document.getElementById('sumSongImg').hidden && document.getElementById('sumNowImg').hidden), 'imágenes del resumen ocultas por defecto');
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
    await waitFor(async () => (await tv.locator('#next .n-item').count()) === before, { msg: 'pantalla tras borrar' });

    // #8: redundancia, nada bajo «A continuación» repite «A continuación ·»
    expect(!(await tv.textContent('.next-wrap')).includes('A continuación ·'), 'texto «A continuación ·» repetido en la lista');

    // #8: tamaño mínimo de 24 px a 1920x1080 (stage y resumen)
    const smallText = (root) => tv.evaluate((sel) => {
      const out = [];
      const rootEl = document.querySelector(sel);
      const path = (e) => { const p = []; for (; e && e !== rootEl && p.length < 4; e = e.parentElement) p.push(e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/).join('.') : '')); return p.join(' < '); };
      for (const e of rootEl.querySelectorAll('*')) {
        if (![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
        const cs = getComputedStyle(e);
        const r = e.getBoundingClientRect();
        if (cs.display === 'none' || cs.visibility === 'hidden' || !r.width || !r.height) continue;
        const px = parseFloat(cs.fontSize);
        if (px < 24) out.push(`${path(e)} ${px}px «${e.textContent.trim().slice(0, 30)}»`);
      }
      return out;
    }, root);
    await tv.setViewportSize({ width: 1920, height: 1080 }); await sleep(400);
    const small = await smallText('#stage');
    expect(small.length === 0, 'texto por debajo de 24px en #stage: ' + small.join(' | '));
    // #24: sin resumen no hay franja
    expect(await tv.evaluate(() => document.getElementById('sumBand').hidden && !document.getElementById('stage').classList.contains('with-band') && document.getElementById('summary').hidden), '#24: sin resumen no hay franja');
    // #24: los toasts grandes no tapan la marca ni el QR
    const toastCheck = async (what) => {
      await api(adminCtx, 'POST', 'admin/control/pause');
      await api(adminCtx, 'POST', 'admin/control/resume');
      await tv.waitForSelector('.big-toast', { timeout: 4000 }); await sleep(800);
      const t = await tv.evaluate(() => {
        const r = (e) => e.getBoundingClientRect();
        const hit = (a, b) => !(a.right <= b.left + 1 || a.left >= b.right - 1 || a.bottom <= b.top + 1 || a.top >= b.bottom - 1);
        const toasts = [...document.querySelectorAll('.big-toast')].map(r);
        const over = ['.brand', '#qrBlock', '.next-wrap'].filter((sel) => toasts.some((b) => hit(b, r(document.querySelector(sel)))));
        return { n: toasts.length, over, inside: toasts.every((b) => b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight) };
      });
      expect(t.n >= 1 && t.over.length === 0 && t.inside, '#24: toast tapa contenido (' + what + '): ' + JSON.stringify(t));
      await waitFor(async () => (await tv.locator('.big-toast').count()) === 0, { timeout: 9000, msg: 'toast no desaparece' });
    };
    await toastCheck('sin resumen');
    // #24: con la fiesta en marcha el resumen es una franja bajo la vista normal
    await api(adminCtx, 'POST', 'admin/summary/show', { on: true });
    try {
      await tv.waitForSelector('#sumBand:not([hidden])', { timeout: 4000 });
      await sleep(900);
      expect(await tv.evaluate(() => document.getElementById('summary').hidden && !document.getElementById('stage').hidden && document.getElementById('stage').classList.contains('with-band')), '#24: la franja convive con la vista normal y no hay resumen a pantalla completa');
      const smallSum = await smallText('#stage');
      expect(smallSum.length === 0, 'texto por debajo de 24px con la franja: ' + smallSum.join(' | '));
      for (const [w, h, name] of [[1920, 1080, '53-tv-band-1080'], [1280, 720, '54-tv-band-720']]) {
        await tv.setViewportSize({ width: w, height: h }); await sleep(600);
        const b = await tv.evaluate(() => {
          const vis = (sel) => { const e = document.querySelector(sel); const r = e.getBoundingClientRect(); return !e.hidden && !!e.offsetParent && r.width > 0 && r.height > 0; };
          const sels = ['.cover-big', '.meta', '.brand', '.next-wrap', '#qrBlock', '#sumBand'];
          const box = (sel) => document.querySelector(sel).getBoundingClientRect();
          const overlaps = [];
          for (let i = 0; i < sels.length; i++) for (let j = i + 1; j < sels.length; j++) {
            const a = box(sels[i]), c = box(sels[j]);
            if (!(a.right <= c.left + 1 || a.left >= c.right - 1 || a.bottom <= c.top + 1 || a.top >= c.bottom - 1)) overlaps.push(sels[i] + ' x ' + sels[j]);
          }
          const off = sels.filter((sel) => { const r = box(sel); return !(r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1); });
          const qr = document.querySelector('#qr').getBoundingClientRect();
          const list = document.getElementById('next'), lr = list.getBoundingClientRect();
          const cut = [...list.children].filter((c) => !c.hidden && c.offsetParent).filter((c) => { const r = c.getBoundingClientRect(); return r.bottom - 1.5 > lr.bottom; }).length;
          return { shown: ['#npTitle', '#qrBlock', '#qrPin', '#sumBand', '#sbDj'].every(vis), listOk: vis('#next') || vis('#nextEmpty'), overlaps, off, qrPx: Math.round(qr.height), qrVh: +(qr.height / innerHeight * 100).toFixed(1), cut, sh: document.documentElement.scrollHeight - innerHeight, sw: document.documentElement.scrollWidth - innerWidth, bandVh: +(box('#sumBand').height / innerHeight * 100).toFixed(1) };
        });
        expect(b.shown && b.listOk, '#24: falta algo a la vista con la franja (' + w + 'x' + h + '): ' + JSON.stringify(b));
        expect(b.overlaps.length === 0 && b.off.length === 0 && b.sh <= 0 && b.sw <= 0 && b.cut === 0, '#24: bloques que se pisan, fuera o con scroll (' + w + 'x' + h + '): ' + JSON.stringify(b));
        expect(b.qrVh >= 18, '#24: el QR es demasiado pequeño con la franja: ' + JSON.stringify(b));
        if (w === 1920) await toastCheck('con franja');
        await shot(tv, name);
      }
      await tv.setViewportSize({ width: 1920, height: 1080 }); await sleep(500);
    } finally {
      await api(adminCtx, 'POST', 'admin/summary/show', { on: false });
    }
    await waitFor(async () => tv.locator('#sumBand').isHidden(), { timeout: 4000, msg: 'franja no se oculta' });
    await tv.waitForSelector('#stage:not([hidden])', { timeout: 4000 });

    // #8: «A continuación» muestra solo lo que cabe entero y cuenta el resto en «y N más» (1920x1080, cola real)
    const listInfo = () => tv.evaluate(() => {
      const l = document.getElementById('next'), mo = document.getElementById('nextMore'), lr = l.getBoundingClientRect();
      const vis = [...l.children].filter((c) => !c.hidden && c.offsetParent);
      const cut = vis.filter((c) => { const r = c.getBoundingClientRect(); return r.bottom - 1.5 > lr.bottom || r.top + 1.5 < lr.top; });
      const mr = mo.getBoundingClientRect(), last = vis.length ? vis[vis.length - 1].getBoundingClientRect() : null;
      return { total: l.children.length, vis: vis.length, cut: cut.length, cls: l.classList.contains('overflow'), mask: getComputedStyle(l).maskImage || getComputedStyle(l).webkitMaskImage, moreShown: !mo.hidden && mo.offsetParent !== null, moreTxt: mo.textContent, moreInView: !mo.hidden && mr.bottom <= innerHeight + 1 && mr.top >= lr.top, moreGap: last ? mr.top - last.bottom : null };
    });
    const checkList = async (what) => {
      const len = (await mockState()).state.queue.length;
      await waitFor(async () => (await tv.locator('#next .n-item').count()) === Math.min(6, len), { msg: `pantalla ${what}: elementos en el DOM` });
      await sleep(900); // fin de la animación de entrada
      const i = await listInfo(), j = JSON.stringify(i);
      expect(i.vis >= 1 && i.cut === 0 && !i.cls && i.mask === 'none', `${what}: ningún elemento a medias y sin máscara: ${j}`);
      const rest = len - i.vis;
      if (rest > 0) {
        expect(i.moreShown && i.moreInView && i.moreTxt === `y ${rest} más en la cola`, `${what}: «más» debe decir ${rest} (cola ${len}, visibles ${i.vis}): ${j}`);
        expect(i.moreGap >= 0 && i.moreGap < 80, `${what}: «más» pegado al último elemento: ${j}`);
      } else expect(!i.moreShown && i.vis === len, `${what}: con todo a la vista no hay «más»: ${j}`);
      return { len, ...i };
    };
    const few = await checkList('cola corta');
    // #24: la lista compacta enseña al menos 3 canciones a 1920x1080 con la cola base
    expect(few.vis >= 3, '#24: la lista compacta debe enseñar 3 o más: ' + JSON.stringify(few));
    // con sitio de sobra (ventana alta) caben todas: sin «más» y todo visible
    await tv.setViewportSize({ width: 1920, height: 2400 }); await sleep(500);
    const roomy = await checkList('cola corta con sitio de sobra');
    expect(roomy.vis === Math.min(6, roomy.len) && !roomy.moreShown, 'con sitio de sobra se ven todas: ' + JSON.stringify(roomy));
    await tv.setViewportSize({ width: 1920, height: 1080 }); await sleep(500);
    const prevSettings = (await api(adminCtx, 'GET', 'admin/status')).body.settings;
    const extra = [];
    try {
      await api(adminCtx, 'PUT', 'admin/settings', { maxQueuedPerGuest: 10, addCooldownSec: 0, noRepeatMin: 0 });
      let n = 0;
      const pool = [34, 35, 36, 37, 38, 39, 40, 24, 25, 26, 27, 28, 29, 13, 14, 15];   // sin usar en el resto del test
      while ((await mockState()).state.queue.length < 9 && n < pool.length) {
        const t = T(pool[n]), c = gctx[n % 3]; n++;
        await api(c, 'GET', `search?q=${encodeURIComponent(t.name.toLowerCase())}`);
        const r = await api(c, 'POST', 'queue', { uri: t.uri });
        expect(r.status === 200, 'añadir a la cola para llenar la lista: ' + JSON.stringify(r));
        extra.push(r.body.item.qid);
      }
      const many = await checkList('cola larga');
      expect(many.len > 6 && many.vis < 6 && many.vis >= 1, 'la cola larga debe pasarse de lo que cabe: ' + JSON.stringify(many));
      // al reducir la ventana caben menos y el contador sube
      await tv.setViewportSize({ width: 1280, height: 720 }); await sleep(500);
      const small = await checkList('cola larga a 1280x720');
      expect(small.vis <= many.vis, 'en una ventana menor no caben más: ' + JSON.stringify([small, many]));
      await tv.setViewportSize({ width: 1920, height: 1080 }); await sleep(500);
      await checkList('cola larga tras volver a 1920x1080');
    } finally {
      for (const qid of extra) await api(adminCtx, 'DELETE', `admin/queue/${qid}`);
      await api(adminCtx, 'PUT', 'admin/settings', { maxQueuedPerGuest: prevSettings.maxQueuedPerGuest, addCooldownSec: prevSettings.addCooldownSec, noRepeatMin: prevSettings.noRepeatMin });
    }
    const back = await checkList('cola de nuevo corta');
    expect(back.len === few.len, 'la cola vuelve a su tamaño: ' + JSON.stringify([few.len, back.len]));

    // #24: « · de X» siempre entero aunque los artistas sean larguísimos
    await tv.setViewportSize({ width: 1920, height: 1080 }); await sleep(500);
    const longBy = await tv.evaluate(() => {
      const li = [...document.querySelectorAll('#next > li')].find((x) => x.querySelector('.n-sub .art'));
      if (!li) return null;
      const sub = li.querySelector('.n-sub'), art = sub.querySelector('.art'), by = sub.querySelector('.by');
      const normalBy = by.textContent;
      art.textContent = 'Bad Bunny, Jhay Cortez, J Balvin, Rosalía, Ozuna, Anuel AA, Daddy Yankee, Karol G, Feid, Myke Towers';
      const s = sub.getBoundingClientRect(), b = by.getBoundingClientRect();
      return { normalBy, byFits: by.scrollWidth <= by.clientWidth + 1, byInside: b.right <= s.right + 1 && b.left >= s.left - 1, artCut: art.scrollWidth > art.clientWidth };
    });
    expect(longBy, '#24: hay un elemento normal en «A continuación»');
    expect(/ · de \S/.test(longBy.normalBy), '#24: «de X» presente: ' + JSON.stringify(longBy.normalBy));
    expect(longBy.byFits && longBy.byInside, '#24: «de X» entero con artistas largos: ' + JSON.stringify(longBy));
    expect(longBy.artCut, '#24: los artistas largos se recortan con puntos suspensivos');
    // #8: todo encaja sin recortes a 1920x1080 y 1280x720
    for (const [w, h, name] of [[1920, 1080, '50-tv-1080'], [1280, 720, '51-tv-720']]) {
      await tv.setViewportSize({ width: w, height: h }); await sleep(500);
      const fit = await tv.evaluate(() => {
        const iw = innerWidth, ih = innerHeight;
        const off = [];
        for (const sel of ['.left', '.right', '.cover-big', '.meta', '.next-wrap', '#next', '#qrBlock']) {
          const r = document.querySelector(sel).getBoundingClientRect();
          if (!(r.left >= -1 && r.top >= -1 && r.right <= iw + 1 && r.bottom <= ih + 1)) off.push(`${sel} fuera: ${[r.left, r.top, r.right, r.bottom].map(Math.round)}`);
        }
        const nw = document.querySelector('.next-wrap').getBoundingClientRect(), qr = document.getElementById('qrBlock').getBoundingClientRect();
        const cover = document.querySelector('.cover-big').getBoundingClientRect();
        return { off, nextOverQr: nw.bottom > qr.top + 1, sh: document.documentElement.scrollHeight - ih, sw: document.documentElement.scrollWidth - iw, coverMeta: cover.bottom > document.querySelector('.meta').getBoundingClientRect().top + 1 };
      });
      expect(fit.off.length === 0, `bloques fuera de la pantalla (${w}x${h}): ${fit.off.join(' | ')}`);
      expect(!fit.nextOverQr, `la lista pisa el QR (${w}x${h})`);
      expect(!fit.coverMeta, `la carátula pisa el texto (${w}x${h})`);
      expect(fit.sh <= 0 && fit.sw <= 0, `hay scroll (${w}x${h}): ${JSON.stringify(fit)}`);
      await shot(tv, name);
    }
    await tv.setViewportSize({ width: 1280, height: 720 });
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
  await step('admin: mover la cola con teclado, deshacer al quitar y confirmaciones anunciadas (#12)', async () => {
    const items = admin.locator('#card-queue .aq-item');
    // orden «de la API»: lo que ve un invitado (el servidor es la fuente), más los votos que pinta el panel
    const names = async () => clean(await queueTitles(g[1]));
    const votesTags = async () => (await admin.locator('#card-queue .aq-item .votes-tag').allTextContents()).map((x) => x.trim());
    const status = async () => ({ names: await names(), votes: await votesTags() });
    const domTitles = async () => (await admin.locator('#card-queue .aq-item .t').allTextContents()).map((x) => x.trim());
    await waitFor(async () => (await items.count()) >= 3);
    const n0 = await names();
    expect(n0.length >= 3 && (await items.count()) === n0.length, 'hacen falta 3 canciones para probar el teclado: ' + n0.join('|'));
    const grip = (i) => items.nth(i).locator('.grip');
    expect((await grip(1).evaluate((b) => b.tagName)) === 'BUTTON', 'el asa es un botón');
    expect(/^Mover .+\. Flechas arriba y abajo/.test(await grip(1).getAttribute('aria-label')), 'etiqueta del asa');
    // ArrowUp en la 2.ª
    await grip(1).focus();
    await admin.keyboard.press('ArrowUp');
    await waitFor(async () => (await names())[0] === n0[1], { msg: 'ArrowUp no reordena en el servidor: ' + (await names()).join('|') });
    await waitFor(async () => (await domTitles())[0].includes(n0[1]), { msg: 'DOM sin reordenar' });
    await waitFor(async () => admin.evaluate(() => document.activeElement?.classList.contains('grip') && document.activeElement.closest('.aq-item') === document.querySelector('#card-queue .aq-item')), { msg: 'el foco no sigue al asa movida' });
    await waitFor(async () => (await admin.locator('#queueLive').textContent()).includes(`${n0[1]}, puesto 1 de`), { msg: 'anuncio: ' + (await admin.locator('#queueLive').textContent()) });
    // ArrowUp en el borde no hace nada
    await admin.keyboard.press('ArrowUp');
    await sleep(300);
    expect((await names())[0] === n0[1], 'en el borde no se mueve');
    // ArrowDown restaura
    await admin.keyboard.press('ArrowDown');
    await waitFor(async () => JSON.stringify(await names()) === JSON.stringify(n0), { msg: 'ArrowDown no restaura: ' + (await names()).join('|') });
    await waitFor(async () => (await admin.locator('#queueLive').textContent()).includes(`${n0[1]}, puesto 2 de`));
    // quitar la 2.ª y deshacer
    const before = await status();
    await items.nth(1).locator('.del').click();
    await waitFor(async () => (await names()).length === before.names.length - 1);
    const undo = admin.locator('#toasts .toast', { hasText: 'Quitada' }).last().locator('button', { hasText: 'Deshacer' });
    await undo.waitFor({ timeout: 3000 });
    await undo.click();
    await waitFor(async () => JSON.stringify(await status()) === JSON.stringify(before), { msg: 'deshacer no restaura puesto y votos: ' + JSON.stringify(await status()) });
    await waitFor(async () => (await admin.locator('#toasts .toast', { hasText: 'Restaurada' }).count()) === 1);
    // confirmacion anunciada
    const clear = admin.locator('#card-queue header button', { hasText: 'Vaciar cola' });
    await clear.click();
    await waitFor(async () => (await admin.locator('#srLive').textContent()).includes('¿Vaciar toda?'), { msg: 'confirmación no anunciada' });
    await waitFor(async () => (await clear.textContent()).includes('Vaciar cola'), { timeout: 5000, msg: 'el botón no se desarma' });
    expect((await names()).length === before.names.length, 'no se vació la cola');
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
  await step('admin: modo fiesta, lo esencial arriba, PIN a mano y rejilla estable (#9)', async () => {
    const tops = () => admin.evaluate(() => Object.fromEntries([...document.querySelectorAll('#cards .acard')].map((c) => { const r = c.getBoundingClientRect(); return [c.id, { x: Math.round(r.left), top: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) }]; })));
    const domOrder = () => admin.evaluate(() => [...document.querySelectorAll('#cards .acard')].map((c) => c.id.replace('card-', '')));
    const state = async () => (await api(adminCtx, 'GET', 'admin/status')).body;
    const prev = (await state()).settings;
    const extra = [];
    try {
      // ---- móvil 390x844 ----
      await admin.setViewportSize({ width: 390, height: 844 }); await sleep(400);
      await admin.evaluate(() => scrollTo(0, 0));
      const m = await tops();
      expect(m['card-player'].top < m['card-queue'].top && m['card-queue'].top < m['card-party'].top, 'móvil: reproducción, cola y luego fiesta: ' + JSON.stringify(m));
      expect(m['card-queue'].top <= 844 * 1.5, 'móvil: la cola empieza dentro de 1,5 pantallas: ' + m['card-queue'].top);
      // el orden de lectura (DOM, y por tanto el foco) es exactamente el del modo fiesta, y coincide con el visual
      const want = ['player', 'queue', 'party', 'guests', 'history', 'device', 'spotify'];
      const dom = await domOrder();
      expect(dom.join() === want.join(), 'móvil: orden del DOM: ' + dom.join());
      const visual = Object.entries(m).sort((a, b) => a[1].top - b[1].top).map(([id]) => id.replace('card-', ''));
      expect(visual.join() === want.join(), 'móvil: orden visual: ' + visual.join());
      // cabecera recogida y sin desbordar
      const head = await admin.evaluate(() => {
        const h = document.querySelector('.a-top').getBoundingClientRect();
        const out = [...document.querySelectorAll('.a-top *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 2 && (r.right > innerWidth + 1 || r.left < -1); }).map((e) => e.tagName + '.' + e.className);
        return { h: Math.round(h.height), out, sw: document.documentElement.scrollWidth };
      });
      expect(head.sw <= 392 && !head.out.length, 'móvil: la cabecera no desborda: ' + JSON.stringify(head));
      expect(head.h <= 140, 'móvil: la cabecera no pasa de dos líneas de estado: ' + head.h);
      // línea de estado, igual que el estado del servidor
      const s1 = await state();
      const line = (await admin.textContent('#topChips')) || '';
      expect(line.includes('Spotify conectado'), 'estado: Spotify conectado: ' + line);
      expect(s1.player.deviceName && line.includes(s1.player.deviceName), 'estado: dispositivo ' + s1.player.deviceName + ': ' + line);
      const nAct = s1.guests.filter((x) => x.active && !x.banned).length, nQ = (await mockState()).state.queue.length;
      expect(nAct >= 2 && line.includes(`${nAct} activos`), `estado: ${nAct} activos: ` + line);
      expect(nQ >= 1 && (await admin.textContent('#card-queue header')).includes(`${nQ} canciones`), `el recuento de la cola (${nQ}) está en la tarjeta Cola`);
      expect(!/en cola/.test(line), 'estado: sin chip «N en cola» en la cabecera: ' + line);
      expect(await admin.locator('#topChips .chip').count() === 3, 'estado: tres chips');
      // PIN a mano: visible, con el PIN, y lleva a la tarjeta
      const pj = admin.locator('#pinJump');
      expect(await pj.isVisible(), 'el enlace del PIN se ve');
      expect((await pj.textContent()).trim() === `PIN ${pin}`, 'el enlace enseña el PIN: ' + await pj.textContent());
      expect(/PIN y QR/.test(await pj.getAttribute('aria-label')), 'aria-label del enlace del PIN');
      const inView = () => admin.evaluate(() => { const r = document.querySelector('#card-party').getBoundingClientRect(); const hb = document.querySelector('.a-top').getBoundingClientRect().bottom; return r.top >= hb - 1 && r.top < innerHeight * 0.6; });
      expect(!(await inView()), 'antes de pulsar, la tarjeta Fiesta queda fuera de la vista');
      await shot(admin, '60-admin-fiesta-movil', { fullPage: false });
      await pj.click();
      await waitFor(inView, { timeout: 3000, msg: 'el PIN de la cabecera no lleva a la tarjeta Fiesta' });
      expect(await admin.evaluate(() => document.activeElement?.id) === 'card-party', 'el foco pasa a la tarjeta Fiesta');
      await admin.evaluate(() => scrollTo(0, 0));

      // ---- escritorio 1440x900 ----
      await admin.setViewportSize({ width: 1440, height: 900 }); await sleep(400);
      await admin.evaluate(() => scrollTo(0, 0));
      expect(await admin.evaluate(() => getComputedStyle(document.querySelector('#cards')).columnCount) === 'auto', 'sin column-count');
      const d0 = await tops();
      expect(d0['card-player'].top < 900 && d0['card-queue'].top < 900, 'escritorio: reproducción y cola empiezan en la primera pantalla: ' + JSON.stringify(d0));
      const xs = [...new Set(Object.values(d0).map((r) => r.x))];
      expect(xs.length === 2, 'escritorio: dos columnas: ' + xs.join());
      const colOf = (r) => (r.x === Math.min(...xs) ? 'a' : 'b');
      const cols = { a: [], b: [] };
      for (const [id, r] of Object.entries(d0).sort((a, b) => a[1].top - b[1].top)) cols[colOf(r)].push(id.replace('card-', ''));
      expect(cols.a.join() === 'player,queue' && cols.b.join() === 'party,guests,history,device,spotify', 'escritorio: reparto por columnas: ' + JSON.stringify(cols));
      // el DOM baja por la primera columna y luego por la segunda
      expect((await domOrder()).join() === [...cols.a, ...cols.b].join(), 'escritorio: el DOM sigue las columnas');
      // la cola crece y ninguna tarjeta cambia de columna
      await api(adminCtx, 'PUT', 'admin/settings', { maxQueuedPerGuest: 10, addCooldownSec: 0, noRepeatMin: 0 });
      const n0 = await admin.locator('#card-queue .aq-item').count();
      for (const [i, gi] of [[34, 0], [35, 1], [36, 0]]) {
        const t = T(i);
        await api(gctx[gi], 'GET', `search?q=${encodeURIComponent(t.name.toLowerCase())}`);
        const r = await api(gctx[gi], 'POST', 'queue', { uri: t.uri });
        expect(r.status === 200, 'añadir a la cola: ' + JSON.stringify(r));
        extra.push(r.body.item.qid);
      }
      await waitFor(async () => (await admin.locator('#card-queue .aq-item').count()) === n0 + 3, { msg: 'las canciones nuevas no llegan al panel' });
      const d1 = await tops();
      for (const id of Object.keys(d0)) expect(d1[id].x === d0[id].x && d1[id].w === d0[id].w, `escritorio: ${id} cambia de columna: ${JSON.stringify([d0[id], d1[id]])}`);
      expect(d1['card-queue'].h > d0['card-queue'].h, 'la cola ha crecido de verdad');
      expect((await admin.textContent('#card-queue header')).includes(`${n0 + 3} canciones`), 'el recuento sube en la tarjeta Cola');
      expect(!/en cola/.test(await admin.textContent('#topChips')), 'sin recuento en la cabecera');
      await shot(admin, '61-admin-fiesta-escritorio', { fullPage: false });
    } finally {
      for (const qid of extra) await api(adminCtx, 'DELETE', `admin/queue/${qid}`);
      await api(adminCtx, 'PUT', 'admin/settings', { maxQueuedPerGuest: prev.maxQueuedPerGuest, addCooldownSec: prev.addCooldownSec, noRepeatMin: prev.noRepeatMin });
      await admin.setViewportSize({ width: 1280, height: 900 });
      await admin.evaluate(() => scrollTo(0, 0));
    }
    await waitFor(async () => (await admin.locator('#card-queue .aq-item').count()) === 3, { msg: 'la cola vuelve a sus 3 canciones' });
  });
  await step('admin: panel por importancia, engranajes, historial plegado y conexión compacta (#36)', async () => {
    const state = async () => (await api(adminCtx, 'GET', 'admin/status')).body;
    const prev = (await state()).settings;
    const tops = () => admin.evaluate(() => Object.fromEntries([...document.querySelectorAll('#cards .acard')].map((c) => { const r = c.getBoundingClientRect(); return [c.id.replace('card-', ''), { x: Math.round(r.left), top: Math.round(r.top + scrollY), w: Math.round(r.width) }]; })));
    const resetUi = () => admin.evaluate(() => { try { for (const k of Object.keys(localStorage)) if (k.startsWith('fiesta.set.open') || k === 'fiesta.hist.open') localStorage.removeItem(k); } catch { /* nada */ } });
    const reload = async () => { await admin.reload(); await admin.waitForSelector('#dash:not([hidden]) #card-queue'); await sleep(500); };
    const expanded = (sel) => admin.locator(sel).getAttribute('aria-expanded');
    await resetUi(); await reload();
    try {
      // ---- móvil: una columna, por importancia ----
      await admin.setViewportSize({ width: 390, height: 844 }); await sleep(400);
      await admin.evaluate(() => scrollTo(0, 0));
      const m = await tops();
      const visual = Object.entries(m).sort((a, b) => a[1].top - b[1].top).map(([id]) => id);
      expect(visual.join() === 'player,queue,party,guests,history,device,spotify', 'móvil: orden: ' + visual.join());
      expect(new Set(Object.values(m).map((r) => r.x)).size === 1, 'móvil: una sola columna');
      expect(await admin.locator('#card-settings').count() === 0 && await admin.locator('#card-classics').count() === 0, 'no hay tarjeta Ajustes ni Clásicos');
      expect(await admin.locator('text=/Clásicos/').count() === 0, 'ni rastro de «Clásicos» en el panel');

      // ---- engranajes: etiqueta, aria-controls y teclado ----
      for (const [card, label] of [['#card-queue', 'Ajustes de la cola'], ['#card-guests', 'Ajustes de los invitados']]) {
        const g = `${card} button.gear`;
        expect(await admin.locator(g).getAttribute('aria-label') === label, `aria-label «${label}»`);
        const ctl = await admin.locator(g).getAttribute('aria-controls');
        expect(ctl && await admin.locator(`${card} #${ctl}`).count() === 1, 'aria-controls apunta al panel dentro de la tarjeta');
        expect(await expanded(g) === 'false' && !(await admin.locator(`#${ctl}`).isVisible()), `${label}: empieza cerrado`);
        await admin.locator(g).focus();
        await admin.keyboard.press('Enter');
        await waitFor(async () => (await expanded(g)) === 'true' && await admin.locator(`#${ctl}`).isVisible(), { msg: `${label}: Enter abre` });
        await admin.keyboard.press('Enter');
        await waitFor(async () => (await expanded(g)) === 'false' && !(await admin.locator(`#${ctl}`).isVisible()), { msg: `${label}: Enter cierra` });
        await admin.keyboard.press('Enter');
        await waitFor(async () => (await expanded(g)) === 'true', { msg: `${label}: Enter abre otra vez` });
        // el panel va encima de la lista dentro de la tarjeta
        const above = await admin.evaluate(({ card, ctl }) => { const p = document.getElementById(ctl).getBoundingClientRect(); const l = document.querySelector(`${card} ul, ${card} .empty-note`)?.getBoundingClientRect(); return !l || p.bottom <= l.top + 1; }, { card, ctl });
        expect(above, `${label}: el panel está encima de la lista`);
      }

      // ---- cambiar un ajuste de cada panel: aviso y API ----
      await watchToasts(admin);
      const next = prev.maxQueuedPerGuest === 5 ? 6 : 5;
      await admin.locator('#card-queue #set-maxQueuedPerGuest').fill(String(next));
      await admin.locator('#card-queue #set-maxQueuedPerGuest').dispatchEvent('change');
      await waitFor(async () => (await seenToasts(admin)).includes('Ajustes guardados'), { msg: 'falta «Ajustes guardados» (Cola)' });
      await waitFor(async () => (await state()).settings.maxQueuedPerGuest === next, { msg: 'la API no refleja el ajuste de la cola' });
      await admin.evaluate(() => { window.__toasts = []; });
      await admin.locator('#card-guests .set', { hasText: 'Pausar y reanudar' }).locator('button', { hasText: 'Solo yo' }).click();
      await waitFor(async () => (await seenToasts(admin)).includes('Ajustes guardados'), { msg: 'falta «Ajustes guardados» (Invitados)' });
      await waitFor(async () => (await state()).settings.pauseMode === 'admin', { msg: 'la API no refleja el ajuste de invitados' });
      // y las reglas condicionales de #10 siguen donde tocan (votos solo con «Por votos», esperas en directo)
      await admin.locator('#card-guests .set', { hasText: 'Saltar canción' }).locator('button', { hasText: 'Por votos' }).click();
      expect(await admin.locator('#card-guests #skipLive').isVisible(), 'por votos: se ve la línea en vivo en Invitados');

      // ---- los paneles se recuerdan ----
      await waitFor(async () => (await state()).settings.skipMode === 'vote', { msg: 'modo de salto guardado' });
      await reload();
      expect(await expanded('#card-queue button.gear') === 'true' && await expanded('#card-guests button.gear') === 'true', 'los engranajes recuerdan que estaban abiertos');
      await admin.locator('#card-queue button.gear').click();
      await reload();
      expect(await expanded('#card-queue button.gear') === 'false' && await expanded('#card-guests button.gear') === 'true', 'cada engranaje recuerda lo suyo');
      await admin.evaluate(() => scrollTo(0, 0));
      await shot(admin, '66-admin-panel-movil', { fullPage: true });

      // ---- historial: plegado con una línea; abierto, tres apartados ----
      const tg = '#card-history .cmp-toggle';
      expect(await expanded(tg) === 'false' && !(await admin.locator('#card-history .hist-body').isVisible()), 'el historial empieza plegado');
      const sm = (await api(adminCtx, 'GET', 'admin/history/current')).body.summary;
      const wantLine = sm && sm.songs ? new RegExp(`^${sm.songs} canci(ón|ones) · ${sm.playLikes} likes?`) : /^Todavía no ha sonado nada$/;
      const line = ((await admin.locator('#card-history header .sub').textContent()) || '').trim();
      expect(wantLine.test(line), 'resumen de una línea: «' + line + '»');
      expect(await admin.locator('#card-history .hsec').count() === 3, 'tres apartados');
      await admin.locator(tg).focus();
      await admin.keyboard.press('Enter');
      await waitFor(async () => (await expanded(tg)) === 'true' && await admin.locator('#card-history .hist-body').isVisible(), { msg: 'Enter abre el historial' });
      const heads = await admin.locator('#card-history .hsec h3').allTextContents();
      expect(heads.join('|') === 'Resumen|Canciones|Crear playlist', 'apartados: ' + heads.join('|'));
      for (const h of ['Resumen', 'Canciones', 'Crear playlist']) expect(await admin.locator('#card-history .hsec', { has: admin.locator('h3', { hasText: h }) }).isVisible(), `se ve «${h}»`);
      expect(await admin.locator('#card-history .builder button', { hasText: 'Crear playlist en Spotify' }).isVisible(), 'el constructor está dentro de Crear playlist');
      await reload();
      expect(await expanded(tg) === 'true', 'el historial recuerda que estaba abierto');
      await admin.locator(tg).click();
      expect(await expanded(tg) === 'false', 'se vuelve a plegar');

      // ---- sin duplicados ----
      expect(await admin.getByText('Abrir pantalla', { exact: true }).count() === 1 && await admin.locator('a[href$="pantalla/"]').count() === 1, 'una sola «Abrir pantalla»');
      expect(await admin.locator('.a-top a[href$="pantalla/"]').count() === 1 && await admin.locator('#card-party a[href$="pantalla/"]').count() === 0, 'y está en la cabecera, no en la tarjeta Fiesta');
      expect(!/en cola/.test(await admin.textContent('#topChips')) && !/en cola/.test(await admin.textContent('#card-player header')), 'el recuento de la cola no está en la cabecera ni en Reproducción');
      expect((await admin.textContent('#card-queue header')).includes(' canciones'), 'el recuento está en la tarjeta Cola');

      // ---- Spotify y Dispositivo: una línea cuando todo va bien ----
      for (const [card, txt] of [['#card-spotify', 'Conectado'], ['#card-device', null]]) {
        expect(await admin.locator(`${card}.compact`).count() === 1, `${card} compacta`);
        expect(await admin.locator(`${card} .cmp-sum`).isVisible() && !(await admin.locator(`${card}-body`).isVisible()), `${card}: una línea y cuerpo oculto`);
        if (txt) expect((await admin.locator(`${card} .cmp-sum`).textContent()).includes(txt), `${card}: ${txt}`);
        const h = await admin.locator(card).evaluate((e) => e.getBoundingClientRect().height);
        expect(h < 100, `${card}: compacta (${Math.round(h)} px)`);
        expect(await admin.locator(`${card} .cmp-toggle`).textContent() === 'Cambiar' && await expanded(`${card} .cmp-toggle`) === 'false', `${card}: botón «Cambiar»`);
      }
      expect((await admin.locator('#card-device .cmp-sum').textContent()).trim() === (await state()).player.deviceName, 'el dispositivo compacto muestra su nombre');
      await admin.locator('#card-device .cmp-toggle').click();
      await admin.waitForSelector('#card-device .dev', { state: 'visible' });
      expect(await expanded('#card-device .cmp-toggle') === 'true' && await admin.locator('#card-device.compact').count() === 0, '«Cambiar» despliega la lista de dispositivos');
      await admin.locator('#card-device .cmp-toggle').click();
      await admin.waitForSelector('#card-device.compact');

      // ---- escritorio ----
      await admin.setViewportSize({ width: 1440, height: 900 }); await sleep(400);
      await admin.evaluate(() => scrollTo(0, 0));
      const d = await tops();
      const xs = [...new Set(Object.values(d).map((r) => r.x))].sort((a, b) => a - b);
      expect(xs.length === 2, 'escritorio: dos columnas');
      const cols = { a: [], b: [] };
      for (const [id, r] of Object.entries(d).sort((a, b) => a[1].top - b[1].top)) cols[r.x === xs[0] ? 'a' : 'b'].push(id);
      expect(cols.a.join() === 'player,queue' && cols.b.join() === 'party,guests,history,device,spotify', 'escritorio: columnas ' + JSON.stringify(cols));
      expect(d.player.top < 900 && d.queue.top < 900 && d.party.top < 900 && d.guests.top < 900, 'escritorio: lo importante en la primera pantalla');
      expect((await admin.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 1, 'sin scroll horizontal');
      await shot(admin, '67-admin-panel-escritorio', { fullPage: true });
      await admin.setViewportSize({ width: 390, height: 844 }); await sleep(300);
      expect((await admin.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 1, 'móvil: sin scroll horizontal');
    } finally {
      await api(adminCtx, 'PUT', 'admin/settings', { maxQueuedPerGuest: prev.maxQueuedPerGuest, pauseMode: prev.pauseMode, skipMode: prev.skipMode });
      await resetUi();
      await admin.setViewportSize({ width: 1280, height: 900 });
      await reload();
      await admin.evaluate(() => scrollTo(0, 0));
    }
  });
  await step('panel: avisos abajo, agrupados, sin tapar la cabecera y sin perder errores (#29)', async () => {
    const prev = (await api(adminCtx, 'GET', 'admin/status')).body.settings;
    const vp = admin.viewportSize();
    const extra = [];
    const boxes = () => admin.evaluate(() => {
      const r = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
      const top = r(document.querySelector('.a-top'));
      const ts = [...document.querySelectorAll('#toasts .toast')].map((e) => ({ ...r(e), text: e.textContent }));
      return { top, ts, vw: innerWidth, vh: innerHeight };
    });
    const overlaps = (s) => s.ts.filter((t) => t.l < s.top.r && t.r > s.top.l && t.t < s.top.b && t.b > s.top.t);
    const cleared = () => waitFor(async () => (await admin.locator('#toasts .toast').count()) === 0, { timeout: 8000, msg: 'los avisos no se van' });
    const addSix = async () => {
      const songs = [37, 38, 39, 36, 34, 35].map(T);
      for (const [i, t] of songs.entries()) {
        const gi = i % 3;
        await api(gctx[gi], 'GET', `search?q=${encodeURIComponent(t.name.toLowerCase())}`);
        const r = await api(gctx[gi], 'POST', 'queue', { uri: t.uri });
        expect(r.status === 200, 'añadir a la cola: ' + JSON.stringify(r));
        extra.push(r.body.item.qid);
      }
      await sleep(500);
    };
    const quitar = async () => { for (const q of extra.splice(0)) await api(adminCtx, 'DELETE', `admin/queue/${q}`); };
    try {
      await api(adminCtx, 'PUT', 'admin/settings', { maxQueuedPerGuest: 10, addCooldownSec: 0, noRepeatMin: 0 });
      await admin.evaluate(() => scrollTo(0, 0));
      await cleared();
      // ---- móvil ----
      await admin.setViewportSize({ width: 390, height: 844 }); await sleep(400);
      await addSix();
      const m = await boxes();
      expect(m.ts.length >= 1 && m.ts.length <= 3, 'móvil: entre 1 y 3 avisos: ' + JSON.stringify(m.ts));
      expect(overlaps(m).length === 0, 'móvil: los avisos tapan la cabecera: ' + JSON.stringify(m));
      expect(m.ts.every((t) => t.b > m.vh - 200 && t.l >= 0 && t.r <= m.vw), 'móvil: avisos abajo y dentro: ' + JSON.stringify(m));
      await shot(admin, '65-admin-avisos-movil', { fullPage: false });
      await quitar(); await cleared();
      // ---- escritorio ----
      await admin.setViewportSize({ width: 1440, height: 900 }); await sleep(400);
      await addSix();
      const d = await boxes();
      expect(overlaps(d).length === 0, 'escritorio: los avisos tapan la cabecera: ' + JSON.stringify(d));
      expect(d.ts.length >= 1 && d.ts.every((t) => t.r > d.vw - 100 && t.b > d.vh - 200), 'escritorio: abajo a la derecha: ' + JSON.stringify(d));
      const adds = d.ts.filter((t) => /añadi(ó|eron)/.test(t.text));
      expect(adds.length === 1, 'un solo aviso de canciones añadidas: ' + JSON.stringify(d.ts.map((t) => t.text)));
      expect(/^\S.* y \d+ más añadieron canciones$/.test(adds[0].text), 'texto agrupado: ' + adds[0].text);
      expect(d.ts.length <= 3, 'como mucho 3 avisos: ' + d.ts.length);
      await shot(admin, '64-admin-avisos-escritorio', { fullPage: false });
      await quitar(); await cleared();
      // ---- los errores no los desaloja el ruido ----
      await admin.evaluate(async () => {
        const { toast } = await import(new URL('../shared.js', document.querySelector('script[src*="admin.js"]').src));
        toast('Fallo de prueba', 'error', 6000);
        for (let i = 1; i <= 4; i++) toast(`Info ${i}`, 'info', 4000);
      });
      const e = await boxes();
      expect(e.ts.some((t) => t.text === 'Fallo de prueba'), 'el error sigue visible: ' + JSON.stringify(e.ts.map((t) => t.text)));
      expect(e.ts.length <= 3, 'tope de 3 con error: ' + e.ts.length);
      expect(e.ts.some((t) => t.text === 'Info 4'), 'el último aviso entra: ' + JSON.stringify(e.ts.map((t) => t.text)));
    } finally {
      await quitar();
      await api(adminCtx, 'PUT', 'admin/settings', { maxQueuedPerGuest: prev.maxQueuedPerGuest, addCooldownSec: prev.addCooldownSec, noRepeatMin: prev.noRepeatMin });
      await admin.setViewportSize(vp);
    }
    await waitFor(async () => (await admin.locator('#card-queue .aq-item').count()) === 3, { msg: 'la cola vuelve a sus 3 canciones' });
    await cleared();
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
    await row.locator('summary').click();
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
    await row2.locator('summary').click();
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
  await step('admin: invitados con menú por fila, buscador y orden (#11)', async () => {
    const guestsApi = async () => (await api(adminCtx, 'GET', 'admin/status')).body.guests;
    const search = admin.locator('#card-guests input[type=search]');
    const added = [];
    try {
      const n0 = (await guestsApi()).length;
      if (n0 <= 10) expect(await search.isHidden(), `sin buscador con ${n0} invitados`);
      // menu por fila: sin botones sueltos hasta abrirlo
      const row = admin.locator('#card-guests .ag-item', { hasText: 'Laura' }).first();
      expect(await row.locator('.ag-btns > button').count() === 0, 'sin botones sueltos en la fila');
      expect(!(await row.locator('button', { hasText: 'Expulsar' }).isVisible()), 'Expulsar oculto con el menú cerrado');
      const sum = row.locator('summary');
      expect((await sum.getAttribute('aria-label')).startsWith('Acciones para'), 'summary con aria-label');
      await sum.click();
      expect(await row.locator('button[role=menuitem]', { hasText: 'Expulsar' }).isVisible() && await row.locator('button[role=menuitem]', { hasText: 'Banear' }).isVisible(), 'el menú muestra las dos acciones');
      await admin.keyboard.press('Escape');
      expect(!(await row.locator('details.row-menu').evaluate((d) => d.open)), 'Escape cierra el menú');
      expect(await sum.evaluate((s) => s === document.activeElement), 'el foco vuelve al summary');
      // teclado: Enter abre y enfoca el primer elemento; Escape cierra
      await sum.focus(); await admin.keyboard.press('Enter');
      await waitFor(async () => (await row.locator('button[role=menuitem]').first().evaluate((b) => b === document.activeElement)), { msg: 'foco en el primer elemento del menú' });
      await admin.keyboard.press('Escape');
      expect(await sum.evaluate((s) => s === document.activeElement), 'Escape devuelve el foco con teclado');
      // solo un menu abierto, y clic fuera cierra
      const row3 = admin.locator('#card-guests .ag-item:not(:has(.ag-btns:empty))').nth(1);
      await sum.click(); await row3.locator('summary').click();
      await waitFor(async () => (await admin.locator('#card-guests details.row-menu[open]').count()) === 1, { msg: 'solo un menú abierto' });
      await admin.locator('#card-guests header h2').click();
      await waitFor(async () => (await admin.locator('#card-guests details.row-menu[open]').count()) === 0, { msg: 'clic fuera cierra el menú' });

      // buscador: aparece con mas de 10
      const names = ['Íñigo'];
      while (names.length + n0 < 12) names.push(`Zeta ${names.length}`);
      for (const name of names) {
        const r = await fetch(`${BASE}/api/join`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.21' }, body: JSON.stringify({ pin, name }) });
        expect(r.status === 200, `entrada ${name}: ${r.status}`);
        added.push(name);
      }
      await search.waitFor({ state: 'visible', timeout: 5000 });
      await search.fill('inigo');
      await waitFor(async () => (await admin.locator('#card-guests .ag-item .nm').allTextContents()).join() === 'Íñigo', { msg: 'filtra «inigo» por Íñigo' });
      await search.fill('INIGO');
      await waitFor(async () => (await admin.locator('#card-guests .ag-item').count()) === 1, { msg: 'sin distinguir mayúsculas' });
      await search.fill('qqqq');
      await waitFor(async () => (await admin.locator('#card-guests .empty-note', { hasText: 'Ningún invitado se llama así' }).isVisible()), { msg: 'mensaje sin resultados' });
      await search.fill('inigo');
      await waitFor(async () => (await admin.locator('#card-guests .ag-item').count()) === 1);
      await sleep(300);
      expect(await search.inputValue() === 'inigo' && (await admin.locator('#card-guests .ag-item').count()) === 1, 'el filtro persiste tras actualizaciones de estado');
      await search.fill('');

      // orden: activos por nombre, inactivos, baneados (con separadores)
      const gs = await guestsApi();
      const nm = (a, b) => a.name.localeCompare(b.name, 'es');
      const exp = [...gs.filter((x) => x.active && !x.banned).sort(nm), ...gs.filter((x) => !x.active && !x.banned).sort(nm), ...gs.filter((x) => x.banned).sort(nm)].map((x) => x.name);
      await waitFor(async () => (await admin.locator('#card-guests .ag-item .nm').allTextContents()).join('|') === exp.join('|'), { msg: 'orden: ' + exp.join('|') });
      const lis = await admin.locator('#card-guests .ag > li').evaluateAll((els) => els.map((e) => (e.classList.contains('ag-sep') ? '#' + e.textContent : e.querySelector('.nm').textContent)));
      const nBan = gs.filter((x) => x.banned).length;
      expect(nBan >= 1, 'hay un baneado del paso anterior');
      const iSep = lis.indexOf(`#Baneados (${nBan})`);
      expect(iSep >= 0 && lis.slice(iSep + 1).includes('Marc') && !lis.slice(0, iSep).includes('Marc'), 'Marc bajo «Baneados»: ' + lis.join(','));
      expect(!lis.some((x) => x.startsWith('#Inactivos')) === (gs.filter((x) => !x.active && !x.banned).length === 0), 'separador Inactivos solo si hay inactivos');

      // captura en movil con el menu abierto
      await admin.setViewportSize({ width: 390, height: 844 });
      const r2 = admin.locator('#card-guests .ag-item', { hasText: 'Zeta' }).first();
      await r2.scrollIntoViewIfNeeded();
      await r2.locator('summary').click();
      await sleep(300);
      const box = await r2.locator('.menu').boundingBox();
      expect(box && box.x >= 0 && box.x + box.width <= 390, 'el menú cabe en 390 px: ' + JSON.stringify(box));
      await shot(admin, '63-admin-invitados');
      await admin.keyboard.press('Escape');
    } finally {
      await admin.setViewportSize({ width: 1280, height: 900 });
      const gs = await guestsApi();
      for (const x of gs.filter((y) => added.includes(y.name))) await api(adminCtx, 'POST', `admin/guests/${encodeURIComponent(x.id)}/kick`);
      await admin.evaluate(() => scrollTo(0, 0));
    }
    await waitFor(async () => (await admin.locator('#card-guests .ag-item .nm', { hasText: /Íñigo|Zeta/ }).count()) === 0, { msg: 'extras expulsados' });
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
    const seen = []; let fedRemaining = null; let fedMax = 0; let fedUi = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      const st = await mockState();
      const cur = st.mock.current;
      if (cur && seen[seen.length - 1] !== cur) seen.push(cur);
      if (st.state.fed) {
        if (!fedUi) fedUi = await g[0].evaluate(() => { const li = document.querySelector('#queue .q-item.fed'); return li ? { by: li.querySelector('.q-by').textContent, label: li.querySelector('.vote').getAttribute('aria-label'), title: li.querySelector('.vote').title, lock: !!li.querySelector('.vote svg rect') } : null; });
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
    expect(fedUi && fedUi.by.startsWith('Ya va a sonar · de ') && fedUi.lock && fedUi.label === 'Ya va a sonar: no se puede votar ni quitar' && fedUi.title === fedUi.label, 'el que ya va dice «Ya va a sonar» y su candado se explica: ' + JSON.stringify(fedUi));
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
    await openHistory(admin);
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
    const tvCtx2 = await newCtx(browser, 'tv'); await tvCtx2.addCookies(await adminCtx.cookies());
    const tv2 = await tvCtx2.newPage(); watch(tv2, 'pantalla-fallo');
    await tv2.goto('pantalla/'); await tv2.waitForSelector('#stage:not([hidden])');
    expect(await tv2.locator('#playerNote').isHidden(), '#8: sin fallos no hay aviso en la pantalla');
    await mockCmd('disconnect');
    await api(gctx[0], 'GET', `search?q=${encodeURIComponent(T(31).name.toLowerCase())}`);
    await api(gctx[0], 'POST', 'queue', { uri: T(31).uri });
    await waitFor(async () => (await g[0].locator('#banner').isVisible()) && (await g[0].textContent('#banner')).includes('parada'), { timeout: 6000, msg: 'banner sin dispositivo' });
    await shot(g[0], '20-guest-no-device');
    await waitFor(async () => (await tv2.locator('#playerNote').isVisible()) && (await tv2.textContent('#playerNote')).trim() === 'La música está parada, avisando al anfitrión…', { timeout: 6000, msg: '#8: aviso de fallo en la pantalla' });
    const pn = await tv2.evaluate(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); const a = r('#playerNote'); return { px: parseFloat(getComputedStyle(document.getElementById('playerNote')).fontSize), overlapQr: ['#qrBlock', '.cover-big', '.meta', '.brand', '.next-wrap'].some((sel) => { const q = r(sel); return !(a.right <= q.left || a.left >= q.right || a.bottom <= q.top || a.top >= q.bottom); }), inside: a.left >= 0 && a.bottom <= innerHeight && a.right <= innerWidth }; });
    expect(pn.px >= 24 && !pn.overlapQr && pn.inside, 'aviso mal colocado, pisa contenido o es pequeño: ' + JSON.stringify(pn));
    await shot(tv2, '52-tv-no-device');
    expect((await admin.textContent('#alerts')).includes('dispositivo'), 'alerta en admin');
    await mockCmd('connect');
    await api(adminCtx, 'POST', 'admin/device', { deviceId: 'mockdev1' });
    await api(adminCtx, 'POST', 'admin/control/resume');
    await api(adminCtx, 'POST', 'admin/control/skip');
    await waitFor(async () => (await mockState()).mock.current === T(31).name, { timeout: 8000, msg: 'se recupera y suena la cancion' });
    await waitFor(async () => g[0].locator('#banner').isHidden());
    await waitFor(async () => tv2.locator('#playerNote').isHidden(), { timeout: 6000, msg: '#8: el aviso desaparece al recuperarse' });
    await tvCtx2.close();
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
    await g[0].waitForSelector('#farewell:not([hidden])', { timeout: 5000 });
    await g[0].waitForSelector('#joinClosed:not([hidden])');
    expect((await g[0].textContent('#farewellTitle')).includes('La fiesta ha terminado'), 'título de la despedida');
    expect(!(await g[0].textContent('#joinNotice')).includes('terminado'), 'sin aviso redundante «ha terminado» con la despedida');
    // region viva siempre presente (sin hidden) para que los lectores de pantalla anuncien el cambio
    expect(await g[0].getAttribute('#joinNotice', 'role') === 'status' && await g[0].getAttribute('#joinNotice', 'hidden') === null, 'aviso como region viva');
    await shot(g[0], '21-guest-party-ended');
    await shot(admin, '44-admin-party-stopped', { fullPage: true });
  });
  await step('despedida en el móvil: resumen de la noche, sobrevive a la expulsión y a recargar (#7)', async () => {
    const sm = (await api(adminCtx, 'GET', 'admin/status')).body.summary;
    expect(sm && sm.songs > 0, 'resumen del servidor con canciones: ' + JSON.stringify(sm));
    const fw = g[0].locator('#farewell');
    const check = async (when) => {
      expect(await fw.isVisible(), `despedida visible ${when}`);
      const t = await fw.textContent();
      expect(t.includes('Tu noche'), `bloque «Tu noche» ${when}: ${t}`);
      if (sm.songOfNight) {
        expect(t.includes('Canción de la noche') && t.includes(sm.songOfNight.name), `canción de la noche ${when}: ${t}`);
        const exp = `${sm.songOfNight.playLikes} ${sm.songOfNight.playLikes === 1 ? 'like' : 'likes'} · ${sm.songOfNight.queueLikes} ${sm.songOfNight.queueLikes === 1 ? 'voto' : 'votos'}`;
        expect(t.includes(exp), `meta de la canción «${exp}» ${when}: ${t}`);
      } else expect(!t.includes('Canción de la noche'), `sin canción de la noche ${when}`);
      if (sm.bestDj) expect(t.includes('DJ de la noche') && t.includes(sm.bestDj.name), `DJ de la noche ${when}: ${t}`);
      else expect(!t.includes('DJ de la noche'), `sin DJ ${when}`);
    };
    await check('al terminar');
    await shot(g[0], '40-guest-farewell', { fullPage: true });
    await sleep(1200); // el servidor corta las conexiones a los 800 ms
    await check('tras la expulsión');
    await g[0].reload();
    await g[0].waitForSelector('#view-join:not([hidden])');
    await g[0].waitForSelector('#farewell:not([hidden])', { timeout: 5000 });
    await check('tras recargar');
    const noScroll = await g[0].evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(noScroll, 'sin scroll horizontal en la despedida');
    // sin cookie (GET /api/party es público) no hay despedida: lleva nombres de invitados
    const anon = await (await fetch(`${BASE}/api/party`)).json();
    expect(anon.farewell === null, 'sin cookie, /api/party no devuelve la despedida: ' + JSON.stringify(anon.farewell));
    expect(!JSON.stringify(anon).match(/"(id|pin|token)"/), 'sin ids ni PIN en /api/party');
    const own = (await api(gctx[0], 'GET', 'party')).body;
    expect(own.farewell && own.farewell.mine && own.farewell.songOfNight && own.farewell.dj, 'el invitado sí recibe songOfNight, dj y mine: ' + JSON.stringify(own.farewell));
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
    expect(p.farewell === null, 'la fiesta nueva no arrastra la despedida');
    await g[0].reload();
    await g[0].waitForSelector('#joinForm:not([hidden])', { timeout: 5000 });
    expect(await g[0].locator('#farewell').isHidden(), 'despedida oculta y formulario de vuelta con fiesta nueva');
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
