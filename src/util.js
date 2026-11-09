import crypto from 'node:crypto';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const randToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const randId = (n = 8) => crypto.randomBytes(Math.ceil(n * 0.75) + 2).toString('base64url').slice(0, n);
export const randPin = () => String(crypto.randomInt(0, 10000)).padStart(4, '0');
export const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function hmac(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

const CTRL_RE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202f\\u2060-\\u206f\\ufeff]', 'g');

/** Limpia un nombre de invitado. Devuelve null si queda vacio. */
export function cleanName(input, max = 24) {
  let s = String(input ?? '');
  // controles, bidi, ancho cero
  s = s.replace(CTRL_RE, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  const chars = [...s];
  if (chars.length > max) s = chars.slice(0, max).join('').trim();
  return s.length ? s : null;
}

export function normQuery(q) {
  return String(q ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export class LRU {
  constructor(max = 300, ttlMs = 600000, now = Date.now) {
    this.max = max; this.ttl = ttlMs; this.now = now; this.map = new Map();
  }
  get(k) {
    const e = this.map.get(k);
    if (!e) return undefined;
    if (e.exp < this.now()) { this.map.delete(k); return undefined; }
    this.map.delete(k); this.map.set(k, e);
    return e.v;
  }
  set(k, v) {
    this.map.delete(k);
    this.map.set(k, { v, exp: this.now() + this.ttl });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  get size() { return this.map.size; }
}

/** Token bucket por clave. rate = tokens/segundo, burst = capacidad. */
export class RateLimiter {
  constructor({ rate, burst, now = Date.now }) {
    this.rate = rate; this.burst = burst; this.now = now; this.m = new Map();
  }
  take(key) {
    const t = this.now();
    let b = this.m.get(key);
    if (!b) { b = { tokens: this.burst, t }; this.m.set(key, b); }
    b.tokens = Math.min(this.burst, b.tokens + ((t - b.t) / 1000) * this.rate);
    b.t = t;
    if (b.tokens >= 1) { b.tokens -= 1; return true; }
    return false;
  }
  prune() {
    const t = this.now();
    for (const [k, b] of this.m) if (t - b.t > 600000) this.m.delete(k);
  }
}

/** Ventana deslizante: max eventos en windowMs. */
export class WindowLimiter {
  constructor({ max, windowMs, now = Date.now }) {
    this.max = max; this.windowMs = windowMs; this.now = now; this.m = new Map();
  }
  _clean(key) {
    const t = this.now();
    const arr = (this.m.get(key) || []).filter((x) => t - x < this.windowMs);
    if (arr.length) this.m.set(key, arr); else this.m.delete(key);
    return arr;
  }
  /** true si todavia se permite (no consume). */
  allowed(key) { return this._clean(key).length < this.max; }
  hit(key) { const arr = this._clean(key); arr.push(this.now()); this.m.set(key, arr); }
  retryAfterMs(key) {
    const arr = this._clean(key);
    if (arr.length < this.max) return 0;
    return Math.max(0, this.windowMs - (this.now() - arr[0]));
  }
  prune() { for (const k of [...this.m.keys()]) this._clean(k); }
}

export class Mutex {
  constructor() { this.chain = Promise.resolve(); }
  run(fn) {
    const p = this.chain.then(fn, fn);
    this.chain = p.then(() => undefined, () => undefined);
    return p;
  }
}

export function pickPublicUrl(u) {
  return String(u || '').replace(/\/+$/, '');
}
