import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickPublicUrl } from './util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;

const MOCK = env.SPOTIFY_MOCK === '1';
const PORT = parseInt(env.PORT || '3000', 10);
const BASE_PATH = ('/' + (env.BASE_PATH ?? '/fiesta').replace(/^\/+|\/+$/g, '')).replace(/^\/$/, '');
const PUBLIC_URL = pickPublicUrl(env.PUBLIC_URL || `http://127.0.0.1:${PORT}${BASE_PATH}`);

/**
 * Proxies de confianza para leer la IP real (X-Forwarded-For). Por defecto, solo redes locales y
 * privadas (un proxy inverso en la misma maquina o en la red de Docker). Acepta "false", un numero
 * de saltos o una lista de IPs/subredes separadas por comas. Nunca uses "true" en un servidor publico.
 */
export function parseTrustProxy(v) {
  const s = String(v ?? '').trim();
  if (!s) return 'loopback,linklocal,uniquelocal';
  if (s === 'false') return false;
  if (s === 'true') return true;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return s;
}

export const config = {
  MOCK,
  PORT,
  BASE_PATH,
  PUBLIC_URL,
  SECURE: PUBLIC_URL.startsWith('https://'),
  ORIGIN: new URL(PUBLIC_URL).origin,
  TRUST_PROXY: parseTrustProxy(env.TRUST_PROXY),
  ADMIN_KEY: env.ADMIN_KEY || '',
  COOKIE_SECRET: env.COOKIE_SECRET || '',
  DATA_DIR: env.DATA_DIR || path.resolve(here, '..', 'data'),
  PUBLIC_DIR: path.resolve(here, '..', 'public'),
  MOCK_SPEED: Math.max(1, parseFloat(env.MOCK_SPEED || '1') || 1),
  HB_MS: parseInt(env.HB_MS || '20000', 10),
  FEED_LEAD_MS: 20000,
  REDIRECT_URI: `${PUBLIC_URL}/api/spotify/callback`,
  SCOPES: 'user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-modify-private',
};

export function assertConfig() {
  const problems = [];
  if (config.ADMIN_KEY.length < 12) problems.push('ADMIN_KEY debe tener al menos 12 caracteres');
  if (config.COOKIE_SECRET.length < 16) problems.push('COOKIE_SECRET debe tener al menos 16 caracteres');
  if (!config.MOCK && !env.PUBLIC_URL) problems.push('PUBLIC_URL es obligatoria: la URL pública con la que entran los invitados (p. ej. https://midominio.com/fiesta)');
  if (config.TRUST_PROXY === true) problems.push('TRUST_PROXY=true permite falsear la IP del cliente: indica la IP o subred de tu proxy, o déjalo vacío');
  return problems;
}
