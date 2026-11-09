import { hmac, safeEqual, RateLimiter, WindowLimiter } from './util.js';

export const ADMIN_COOKIE = 'fiesta_admin';
export const GUEST_COOKIE = 'fiesta_guest';
const ADMIN_TTL_MS = 30 * 24 * 3600 * 1000;
export const GUEST_TTL_S = 24 * 3600;

export function makeAdminCookie(secret, now = Date.now()) {
  const exp = String(now + ADMIN_TTL_MS);
  return `${exp}.${hmac(secret, 'admin.' + exp)}`;
}

export function verifyAdminCookie(secret, value, now = Date.now()) {
  if (typeof value !== 'string') return false;
  const i = value.indexOf('.');
  if (i < 1) return false;
  const exp = value.slice(0, i); const sig = value.slice(i + 1);
  if (!/^\d{10,15}$/.test(exp) || Number(exp) < now) return false;
  return safeEqual(sig, hmac(secret, 'admin.' + exp));
}

export function createLimiters(now = Date.now) {
  return {
    adminLogin: new WindowLimiter({ max: 5, windowMs: 60000, now }),
    joinFail: new WindowLimiter({ max: 5, windowMs: 60000, now }),
    joinAll: new WindowLimiter({ max: 40, windowMs: 60000, now }),
    search: new RateLimiter({ rate: 1, burst: 5, now }),
    action: new RateLimiter({ rate: 1, burst: 4, now }),
  };
}

export function cookieOpts(config, { maxAgeS, path } = {}) {
  return {
    path: path || config.BASE_PATH || '/',
    httpOnly: true,
    secure: config.SECURE,
    sameSite: 'lax',
    ...(maxAgeS ? { maxAge: maxAgeS } : {}),
  };
}

/** Comprueba cabecera Origin (si viene). */
export function originAllowed(config, origin) {
  if (!origin) return true;
  if (origin === config.ORIGIN) return true;
  if (!config.SECURE || config.MOCK) {
    try {
      const u = new URL(origin);
      return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    } catch { return false; }
  }
  return false;
}
