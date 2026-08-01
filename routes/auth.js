const router = require('express').Router();
const { rateLimit } = require('../lib/security');
const {
  createSession, destroySession, isValidSession, readCookie,
  setSessionCookie, clearSessionCookie, verifyPin, COOKIE_NAME,
} = require('../lib/auth');

/**
 * POST /api/auth/login — exchange the staff PIN for a session cookie.
 *
 * Rate limited to 8 attempts per 15 minutes per IP: the credential is a short
 * PIN, so without a limit the entire keyspace is brute-forceable in seconds.
 * The failure response is deliberately identical whether the PIN was missing
 * or wrong, so it cannot be used as an oracle.
 */
router.post('/login', rateLimit('staff-login', 8, 15 * 60 * 1000), (req, res) => {
  if (!verifyPin(req.body && req.body.pin)) {
    return res.status(401).json({ ok: false, error: 'Incorrect PIN' });
  }
  const token = createSession();
  setSessionCookie(res, token);
  res.json({ ok: true });
});

/** POST /api/auth/logout — destroy the session server-side, not just client-side. */
router.post('/logout', (req, res) => {
  destroySession(readCookie(req, COOKIE_NAME));
  clearSessionCookie(res);
  res.json({ ok: true });
});

/** GET /api/auth/session — lets the dashboard restore state after a reload. */
router.get('/session', (req, res) => {
  res.json({ ok: true, authenticated: isValidSession(readCookie(req, COOKIE_NAME)) });
});

module.exports = router;
