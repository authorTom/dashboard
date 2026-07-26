import {
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

const COOKIE = 'dash_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;

const SECURE = process.env.SECURE_COOKIES === '1';

/** token -> expiry timestamp. One admin, so this stays tiny. */
const sessions = new Map();
/** ip -> { count, until }. Cleared on success. */
const attempts = new Map();

let passwordHash = null;
let passwordSalt = null;

export async function init() {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    throw new Error(
      'ADMIN_PASSWORD is not set. Copy .env.example to .env and set one, ' +
        'then start with: node --env-file=.env server.js'
    );
  }
  if (password === 'changeme') {
    console.warn(
      '[auth] ADMIN_PASSWORD is still the example value — change it before exposing this dashboard.'
    );
  }
  passwordSalt = randomBytes(16);
  passwordHash = await scrypt(password, passwordSalt, 64);
}

/** Drops expired sessions and lockouts. Cheap, so it runs on each login. */
function sweep() {
  const now = Date.now();
  for (const [token, expiry] of sessions) {
    if (expiry <= now) sessions.delete(token);
  }
  for (const [ip, record] of attempts) {
    if (record.until <= now) attempts.delete(ip);
  }
}

function clientIp(req) {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

export function isLockedOut(req) {
  const record = attempts.get(clientIp(req));
  if (!record) return false;
  if (record.until <= Date.now()) {
    attempts.delete(clientIp(req));
    return false;
  }
  return record.count >= MAX_ATTEMPTS;
}

function recordFailure(req) {
  const ip = clientIp(req);
  const record = attempts.get(ip) ?? { count: 0, until: 0 };
  record.count += 1;
  record.until = Date.now() + LOCKOUT_MS;
  attempts.set(ip, record);
}

export async function verifyPassword(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  // Hash the candidate before comparing so the comparison is fixed-width and
  // reveals nothing about the real password's length.
  const derived = await scrypt(candidate, passwordSalt, 64);
  return timingSafeEqual(derived, passwordHash);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function isAuthed(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return false;
  const expiry = sessions.get(token);
  if (!expiry) return false;
  if (expiry <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export async function login(req, res, password) {
  sweep();
  if (isLockedOut(req)) {
    console.warn(`[auth] locked out ${clientIp(req)} — too many failed logins`);
    return { ok: false, status: 429, error: 'Too many attempts. Try again later.' };
  }
  if (!(await verifyPassword(password))) {
    recordFailure(req);
    // Logged so a self-hosted operator can tell a typo from a brute-force
    // attempt — and so "my password doesn't work" is answerable.
    const { count } = attempts.get(clientIp(req));
    console.warn(
      `[auth] failed login from ${clientIp(req)} (${count}/${MAX_ATTEMPTS} before lockout)`
    );
    return { ok: false, status: 401, error: 'Incorrect password.' };
  }

  attempts.delete(clientIp(req));
  const token = randomBytes(32).toString('base64url');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: SECURE,
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
  return { ok: true };
}

export function logout(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) sessions.delete(token);
  res.clearCookie(COOKIE, { path: '/', sameSite: 'strict', secure: SECURE });
}

/** Gate for every write endpoint. */
export function requireAuth(req, res, next) {
  if (!isAuthed(req)) {
    return res.status(401).json({ error: 'Not signed in.' });
  }
  next();
}
