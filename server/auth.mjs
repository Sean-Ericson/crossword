/*
 * auth.mjs — password hashing (scrypt), cookie sessions, and a small
 * failed-login limiter. Accounts are created by the admin CLI; there is
 * no public sign-up, since the site faces the internet.
 */

import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const SESSION_COOKIE = 'xw_session';

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password.normalize('NFKC'), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password.normalize('NFKC'), Buffer.from(saltHex, 'hex'), expected.length, SCRYPT);
  return timingSafeEqual(expected, actual);
}

/** Temporary password: 4 groups of 4 unambiguous characters (~80 bits), easy to read out. */
export function tempPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += alphabet[bytes[i] % alphabet.length];
    if (i % 4 === 3 && i < 15) out += '-';
  }
  return out;
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) return 'Passwords need at least 8 characters.';
  if (password.length > 200) return 'That password is too long.';
  return null;
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

/** Create a session for `user`; returns the raw token for the cookie. */
export function startSession(store, user, days) {
  const token = randomBytes(32).toString('base64url');
  store.createSession(hashToken(token), user.id, Date.now() + days * 86400_000);
  return token;
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (key) out[key] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function sessionCookie(token, { maxAgeDays, secure }) {
  const bits = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.round(maxAgeDays * 86400)}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

export function clearedCookie({ secure }) {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

/** The logged-in user for a request (or upgrade request), else null. */
export function userFromRequest(store, req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  return store.sessionUser(hashToken(token));
}

/**
 * Failed-login limiter: after `max` failures for an ip or a username in
 * `windowMs`, further attempts are refused until the window passes.
 */
export class LoginLimiter {
  constructor({ max = 10, windowMs = 15 * 60_000 } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.failures = new Map(); // key -> [timestamps]
  }

  recent(key, now) {
    const list = (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }

  blocked(keys, now = Date.now()) {
    return keys.some((k) => this.recent(k, now).length >= this.max);
  }

  fail(keys, now = Date.now()) {
    for (const k of keys) this.failures.set(k, [...this.recent(k, now), now]);
  }

  succeed(keys) {
    for (const k of keys) this.failures.delete(k);
  }
}

/** Public view of a user row. */
export function publicUser(u) {
  return u && { name: u.name, display_name: u.display_name, color: u.color, is_admin: !!u.is_admin };
}
