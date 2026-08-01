const crypto = require('crypto');

/**
 * Staff authentication and the authorization boundary for every staff-only
 * endpoint.
 *
 * Before this existed, `POST /api/auth/login` verified the PIN and returned
 * `{ok:true}` — but issued no credential, and no other route checked anything.
 * The admin dashboard was a client-side screen in front of a completely open
 * API: anyone could read all customer names, phones and delivery addresses,
 * edit orders, hide menu items, or post content to the homepage with an
 * unauthenticated curl. This module closes that.
 *
 * Design notes:
 *  - Server-side session store, opaque random token, httpOnly cookie. Sessions
 *    live in memory: a restart logs staff out, which is an acceptable trade for
 *    a single-instance single-location deployment and avoids inventing a
 *    signed-token revocation story. If this is ever load-balanced across
 *    processes, this must move to a shared store (Redis) — see README.
 *  - The PIN is compared in constant time. A plain `===` on a secret leaks its
 *    contents through timing.
 *  - Login is rate limited hard. A 4-digit PIN is 10,000 guesses; without a
 *    limit that is seconds of scripted brute force.
 *  - No new dependency: the cookie header is parsed directly (adding a package
 *    is a HIGH-RISK review trigger, and this is ~6 lines).
 */

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // one shift
const COOKIE_NAME = 'sc_staff';
const sessions = new Map(); // token -> { expires }

function nowMs() { return Date.now(); }

/** Drops expired sessions so the map cannot grow without bound. */
function sweepSessions() {
  const t = nowMs();
  for (const [token, s] of sessions) if (s.expires <= t) sessions.delete(token);
}

function createSession() {
  sweepSessions();
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { expires: nowMs() + SESSION_TTL_MS });
  return token;
}

function destroySession(token) { if (token) sessions.delete(token); }

function isValidSession(token) {
  if (!token) return false;
  const s = sessions.get(token);
  if (!s) return false;
  if (s.expires <= nowMs()) { sessions.delete(token); return false; }
  return true;
}

/** Minimal cookie-header parser — avoids pulling in cookie-parser. */
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? ' Secure;' : '';
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${token}; HttpOnly;${secure} SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

/** Timing-safe comparison of two secrets of arbitrary length. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  // timingSafeEqual throws on length mismatch, which itself leaks length —
  // hash both sides first so the compared buffers are always 32 bytes.
  const ha = crypto.createHash('sha256').update(ba).digest();
  const hb = crypto.createHash('sha256').update(bb).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function verifyPin(pin) {
  const expected = process.env.ADMIN_PIN;
  if (!expected) return false;         // fail closed when unconfigured
  if (!pin) return false;
  return safeEqual(pin, expected);
}

/**
 * Express middleware: rejects any request without a valid staff session.
 * Applied to every staff-only route in routes/*.js.
 */
function requireStaff(req, res, next) {
  const token = readCookie(req, COOKIE_NAME);
  if (!isValidSession(token)) {
    return res.status(401).json({ ok: false, error: 'Staff sign-in required' });
  }
  req.staffToken = token;
  next();
}

/**
 * Boot-time configuration check. Refuses to start with a missing or obviously
 * placeholder PIN rather than silently exposing the dashboard to a guess.
 */
function assertAdminPinConfigured() {
  const pin = process.env.ADMIN_PIN;
  const weak = ['', 'change-me', 'changeme', 'admin', 'password', '0000', '1234'];
  if (!pin || weak.includes(String(pin).toLowerCase())) {
    console.error('');
    console.error('  ✗  ADMIN_PIN is missing or still set to a default value.');
    console.error('     Staff sign-in protects every order, customer address and');
    console.error('     sales figure in this system. Set a strong ADMIN_PIN in .env');
    console.error('     before starting.');
    console.error('');
    return false;
  }
  return true;
}

module.exports = {
  COOKIE_NAME, createSession, destroySession, isValidSession,
  readCookie, setSessionCookie, clearSessionCookie,
  verifyPin, requireStaff, assertAdminPinConfigured,
};
