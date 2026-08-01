/**
 * Structured JSON logging.
 *
 * Route handlers previously swallowed database errors into a bare
 * `res.status(500)` with no record of what actually failed, which makes a
 * production incident unbreakable: you know an order failed, not why. Every
 * catch block now logs through here.
 *
 * JSON lines so a log shipper can parse them. Never log request bodies,
 * PINs, session tokens, or Stripe secrets.
 */

function emit(level, event, fields = {}) {
  const line = { ts: new Date().toISOString(), level, event, ...fields };
  const out = level === 'error' ? console.error : console.log;
  out(JSON.stringify(line));
}

const log = {
  info: (event, fields) => emit('info', event, fields),
  warn: (event, fields) => emit('warn', event, fields),
  /** Logs an Error without leaking a stack trace to the client. */
  error: (event, err, fields = {}) => emit('error', event, {
    ...fields,
    err: err && err.message,
    code: err && err.code,
  }),
};

/**
 * Wraps an async route handler so a rejected promise becomes a logged 500
 * instead of an unhandled rejection that silently kills the response.
 */
function route(name, handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (err) {
      log.error('route_failed', err, { route: name, method: req.method, path: req.path });
      if (!res.headersSent) res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
    }
  };
}

module.exports = { log, route };
