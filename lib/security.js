const crypto = require('crypto');

// Unguessable order/reservation reference (not a sequential/guessable ID).
// 8 hex chars = 4 bytes = ~4.3e9 values. Callers must handle the (rare)
// UNIQUE-constraint collision — see makeUniqueRef in routes/orders.js.
function makeRef(prefix) {
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${prefix}-${rand}`;
}

/**
 * In-memory fixed-window rate limiter for sensitive endpoints (order creation,
 * checkout session creation, staff login).
 *
 * Two properties this needs and did not previously have:
 *
 *  1. Bounded memory. The hit map never evicted expired entries, so it grew by
 *     one permanent entry per unique client IP — an unbounded leak on any
 *     public deployment. Expired entries are now swept opportunistically.
 *
 *  2. A correct client identity. `req.ip` is the socket address unless Express
 *     is told to trust the proxy. Behind nginx/Cloudflare every request appears
 *     to come from the proxy, so all customers share one bucket and a handful
 *     of orders locks out the whole restaurant. server.js sets `trust proxy`
 *     from the TRUST_PROXY env var; set it when deploying behind a proxy, and
 *     leave it off otherwise (trusting X-Forwarded-For unconditionally lets a
 *     client spoof its way around the limit).
 *
 * Single-process only. A multi-instance deployment needs a shared store.
 */
function rateLimit(bucket, max, windowMs) {
  const hits = new Map();
  let lastSweep = 0;

  function sweep(now) {
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
  }

  return (req, res, next) => {
    const now = Date.now();
    sweep(now);

    const key = bucket + ':' + (req.ip || req.socket.remoteAddress || 'unknown');
    const entry = hits.get(key);

    if (!entry || now - entry.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return next();
    }

    entry.count += 1;
    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.start + windowMs - now) / 1000);
      res.setHeader('Retry-After', String(Math.max(retryAfter, 1)));
      return res.status(429).json({ ok: false, error: 'Too many requests — please wait a moment and try again.' });
    }
    next();
  };
}

/**
 * Clamps a caller-supplied pagination window to a hard server-side ceiling.
 * Collection endpoints must never let a client ask for the whole table.
 */
function parsePaging(query, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const rawLimit = parseInt(query.limit, 10);
  const rawOffset = parseInt(query.offset, 10);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, maxLimit) : defaultLimit;
  const offset = Number.isInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  return { limit, offset };
}

module.exports = { makeRef, rateLimit, parsePaging };
