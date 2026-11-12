// Utilidades comunes: API, DOM, iconos, reloj, SSE, toasts, FLIP.

export const BASE = new URL('./', import.meta.url).pathname;
export const API = BASE + 'api/';

export class ApiError extends Error {
  constructor(status, code, message, data) { super(message); this.status = status; this.code = code; this.data = data || {}; }
}

export async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (method === 'POST' || method === 'PUT') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body ?? {});
  }
  let res;
  try { res = await fetch(API + path, opts); } catch { throw new ApiError(0, 'network', 'Sin conexión. Revisa tu internet.'); }
  let data = null;
  try { data = await res.json(); } catch { /* sin cuerpo */ }
  if (!res.ok) throw new ApiError(res.status, data?.error, data?.message || 'Algo ha fallado. Prueba otra vez.', data);
  return data;
}

// ---------- DOM ----------
export function el(tag, props, ...children) {
  const n = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
  }
  append(n, children);
  return n;
}
function append(n, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export function setText(n, t) { if (n.textContent !== t) n.textContent = t; }
/** «artistas · de X» en una línea: se recortan los artistas y el sufijo se ve siempre entero (#42). */
export function setArtBy(n, art, by) {
  n.classList.add('art-by');
  let a = n.querySelector(':scope > .art'); let b = n.querySelector(':scope > .by');
  if (!a || !b) { n.textContent = ''; a = el('span', { class: 'art' }); b = el('span', { class: 'by' }); n.append(a, b); }
  setText(a, art); setText(b, by);
}
export function setSrc(img, src) { if (src && img.getAttribute('src') !== src) img.setAttribute('src', src); if (!src) img.removeAttribute('src'); }

const ICONS = {
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
  skip: '<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" x2="19" y1="5" y2="19"/>',
  heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  grip: '<circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/>',
  up: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
  expand: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  link: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  volume: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>',
  edit: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  speaker: '<rect width="16" height="20" x="4" y="2" rx="2"/><circle cx="12" cy="14" r="4"/><line x1="12" x2="12.01" y1="6" y2="6"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
};
const FILLED = new Set(['play', 'skip', 'pause']);
export function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `ico ${FILLED.has(name) ? 'fill' : ''} ${cls}`.trim());
  svg.innerHTML = ICONS[name] || ''; // constantes estaticas, nunca datos de usuario
  return svg;
}
export function setIcon(host, name, cls) { host.replaceChildren(icon(name, cls)); }

// ---------- formato ----------
export function fmtTime(ms) {
  const t = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}
export function fmtAgo(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'ahora';
  if (m < 60) return `hace ${m} min`;
  return `hace ${Math.floor(m / 60)} h`;
}
export const artistsText = (a) => (a || []).join(', ');

// ---------- reloj del servidor ----------
let offset = 0;
export function syncClock(serverNow) { if (serverNow) offset = serverNow - Date.now(); }
export const serverTime = () => Date.now() + offset;
export function liveProgress(np, scale = 1) {
  if (!np) return 0;
  if (!np.isPlaying) return np.progressMs;
  return Math.min(np.durationMs, np.progressMs + (serverTime() - np.at) * scale);
}

// ---------- toasts ----------
/** `action` opcional: { label, onclick(toastEl) }. El toast con accion recibe clics y el boton es alcanzable con teclado.
 *  Devuelve el elemento, con `update(text, ms?)`: cambia el texto (se anuncia una vez) y reinicia la cuenta atras.
 *  Si hay mas de 3, se retira el mas antiguo que no sea error ni lleve accion; solo si todos lo son, el mas antiguo. */
export function toast(text, kind = 'info', ms = 3600, action = null) {
  let host = document.getElementById('toasts');
  if (!host) { host = el('div', { id: 'toasts', 'aria-live': 'polite' }); document.body.append(host); }
  const t = el('div', { class: `toast ${kind}${action ? ' has-action' : ''}` });
  t.append(el('span', { text }));
  if (action) {
    const b = el('button', { type: 'button', class: 'toast-action', text: action.label });
    b.addEventListener('click', () => action.onclick(t));
    t.append(b);
  }
  host.append(t);
  while (host.children.length > 3) {
    const kids = [...host.children];
    (kids.find((c) => !c.classList.contains('error') && !c.classList.contains('has-action')) || kids[0]).remove();
  }
  let timer;
  const arm = (d) => { clearTimeout(timer); timer = setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 260); }, d); };
  t.update = (next, d = ms) => { t.firstChild.textContent = next; arm(d); };
  arm(ms);
  return t;
}

// ---------- SSE con reconexion ----------
export function connectEvents({ onState, onToast, onStatus, onKicked, onUnauthorized, probe, path = 'events' }) {
  let es = null; let backoff = 1000; let failures = 0; let timer = null; let closed = false; let hiddenAt = 0;
  const status = (s) => onStatus && onStatus(s);
  function open() {
    if (closed) return;
    clearTimeout(timer);
    try { es?.close(); } catch { /* ignorar */ }
    es = new EventSource(API + path);
    es.addEventListener('state', (e) => {
      backoff = 1000; failures = 0; status('open');
      try { onState(JSON.parse(e.data)); } catch (err) { console.error(err); }
    });
    es.addEventListener('toast', (e) => { try { onToast && onToast(JSON.parse(e.data)); } catch { /* ignorar */ } });
    es.addEventListener('kicked', () => { closed = true; es.close(); onKicked && onKicked(); });
    es.onerror = async () => {
      try { es.close(); } catch { /* ignorar */ }
      if (closed) return;
      failures++; status('reconnecting');
      if (failures >= 2 && probe) {
        try { await probe(); } catch (e) { if (e instanceof ApiError && (e.status === 401 || e.status === 403)) { closed = true; onUnauthorized && onUnauthorized(); return; } }
      }
      timer = setTimeout(open, backoff);
      backoff = Math.min(10000, Math.round(backoff * 1.7));
    };
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (!closed && (!es || es.readyState !== 1 || Date.now() - hiddenAt > 15000)) { backoff = 1000; open(); }
  });
  window.addEventListener('online', () => { if (!closed) { backoff = 1000; open(); } });
  open();
  return { close() { closed = true; clearTimeout(timer); try { es?.close(); } catch { /* ignorar */ } }, reopen() { closed = false; backoff = 1000; open(); } };
}

// ---------- listas con claves + FLIP ----------
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function captureRects(container) {
  const m = new Map();
  for (const c of container.children) if (c.dataset.key) m.set(c.dataset.key, c.getBoundingClientRect());
  return m;
}
export function playFlip(container, prev) {
  if (reduceMotion()) return;
  for (const c of container.children) {
    const p = prev.get(c.dataset.key);
    if (!p) continue;
    const r = c.getBoundingClientRect();
    const dy = p.top - r.top;
    if (Math.abs(dy) < 2) continue;
    c.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 380, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
  }
}
/** Sincroniza hijos de container con items (clave estable), reutilizando nodos. */
export function reconcile(container, items, keyFn, create, update) {
  const existing = new Map();
  for (const c of [...container.children]) if (c.dataset.key) existing.set(c.dataset.key, c);
  const prev = captureRects(container);
  let idx = 0;
  for (const it of items) {
    const k = String(keyFn(it));
    let node = existing.get(k);
    const fresh = !node;
    if (!node) { node = create(it); node.dataset.key = k; }
    existing.delete(k);
    update(node, it, fresh);
    if (container.children[idx] !== node) container.insertBefore(node, container.children[idx] || null);
    idx++;
  }
  for (const n of existing.values()) n.remove();
  playFlip(container, prev);
}

export function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  return new Promise((res, rej) => {
    const t = el('textarea', { style: { position: 'fixed', opacity: '0' } }); t.value = text; document.body.append(t); t.select();
    try { document.execCommand('copy') ? res() : rej(new Error('copy')); } catch (e) { rej(e); } finally { t.remove(); }
  });
}

export function safeStorage() {
  return {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignorar */ } },
  };
}

/**
 * Tinte de la caratula: color dominante (vivo y legible sobre oscuro) en la variable CSS --tint como "r g b".
 * La CDN de Spotify permite CORS; si una imagen no se puede leer, se queda el tinte neutro.
 */
const tintCache = new Map();
let tintWant = null;
const NEUTRAL_TINT = '74 74 84';
function dominant(img) {
  const c = document.createElement('canvas'); c.width = 24; c.height = 24;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, 24, 24);
  const d = g.getImageData(0, 0, 24, 24).data;
  let r = 0; let gr = 0; let b = 0; let w = 0;
  for (let i = 0; i < d.length; i += 4) {
    const R = d[i]; const G = d[i + 1]; const B = d[i + 2];
    const mx = Math.max(R, G, B); const mn = Math.min(R, G, B);
    const sat = mx ? (mx - mn) / mx : 0;
    const wt = 0.15 + sat * sat * (mx / 255);           // pesan mas los pixeles con color
    r += R * wt; gr += G * wt; b += B * wt; w += wt;
  }
  if (!w) return NEUTRAL_TINT;
  let [h, s, l] = rgbToHsl(r / w, gr / w, b / w);
  s = Math.min(0.85, s * 1.15); l = Math.min(0.5, Math.max(0.32, l));   // ni apagado ni chillon
  return hslToRgb(h, s, l).map(Math.round).join(' ');
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b); const mn = Math.min(r, g, b); const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const dd = mx - mn; const s = l > 0.5 ? dd / (2 - mx - mn) : dd / (mx + mn);
  const h = mx === r ? (g - b) / dd + (g < b ? 6 : 0) : mx === g ? (b - r) / dd + 2 : (r - g) / dd + 4;
  return [h / 6, s, l];
}
function hslToRgb(h, s, l) {
  const f = (n) => { const k = (n + h * 12) % 12; const a = s * Math.min(l, 1 - l); return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))); };
  return [f(0), f(8), f(4)];
}
export function applyTint(url) {
  const root = document.documentElement;
  tintWant = url || null;
  if (!url) { root.style.setProperty('--tint', NEUTRAL_TINT); return; }
  if (tintCache.has(url)) { root.style.setProperty('--tint', tintCache.get(url)); return; }
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';
  img.onload = () => {
    let v = NEUTRAL_TINT;
    try { v = dominant(img); } catch { /* imagen sin CORS: tinte neutro */ }
    tintCache.set(url, v);
    if (tintWant === url) root.style.setProperty('--tint', v);
  };
  img.onerror = () => { tintCache.set(url, NEUTRAL_TINT); };
  img.src = url;
}

/** Fondo desenfocado con fundido entre caratulas. */
export function makeBackground(host) {
  let current = null; let url = null;
  return (next) => {
    if (next === url) return;
    url = next;
    applyTint(next);
    const layer = el('div', { class: 'bg-layer' });
    if (next) layer.style.backgroundImage = `url(${JSON.stringify(next)})`;
    host.append(layer);
    requestAnimationFrame(() => requestAnimationFrame(() => layer.classList.add('on')));
    const old = current; current = layer;
    if (old) { old.classList.remove('on'); setTimeout(() => old.remove(), 1200); }
  };
}
