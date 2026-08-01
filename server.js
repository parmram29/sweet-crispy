require('dotenv').config();
const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');
const path    = require('path');
const { log }  = require('./lib/log');
const { assertAdminPinConfigured } = require('./lib/auth');

const app = express();

// Only trust X-Forwarded-For when explicitly deployed behind a proxy. Trusting
// it unconditionally would let any client spoof its source address and walk
// around the rate limiters; never trusting it puts every customer behind a
// proxy into one shared rate-limit bucket. Set TRUST_PROXY=1 when there is a
// reverse proxy in front of this process.
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
app.disable('x-powered-by');

// Sets standard defensive headers (X-Content-Type-Options, X-Frame-Options,
// Referrer-Policy, HSTS, etc).
//
// The frontend (public/js/) is ES modules with event delegation — no inline
// onclick="" handlers anywhere — so script-src can stay at a strict 'self'
// with no 'unsafe-inline' needed. That makes CSP a real XSS backstop here,
// on top of (not instead of) output-encoding every customer-supplied value
// before it's interpolated into innerHTML (see escapeHtml() in
// public/js/services/format.js, used throughout the page classes).
// style-src still needs 'unsafe-inline': the markup uses inline style=""
// attributes for one-off layout tweaks. That's a much smaller risk than
// inline script would be — CSS injection can't execute arbitrary JS — and
// is left as-is rather than converting every inline style to a class.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
}));

// The frontend is served from this same origin, so no cross-origin access is
// required. `cors()` with no options reflected every origin, which is a wide
// default for an API that now carries a staff session cookie. Set
// CORS_ORIGIN only if a genuinely separate front end ever needs access.
app.use(cors(process.env.CORS_ORIGIN
  ? { origin: process.env.CORS_ORIGIN.split(',').map(s => s.trim()), credentials: true }
  : { origin: false }));

// The Stripe webhook needs the raw request body to verify its signature, so it
// must be registered before the global express.json() parser.
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth',         require('./routes/auth'));
app.use('/api/menu',         require('./routes/menu'));
app.use('/api/specials',     require('./routes/specials'));
app.use('/api/orders',       require('./routes/orders'));
app.use('/api/payments',     require('./routes/payments'));
app.use('/api/sales',        require('./routes/sales'));
app.use('/api/reservations', require('./routes/reservations'));

app.get('/api/ping', (req, res) => res.json({ ok: true, message: 'Sweet & Crispy server running' }));

// Unknown /api/* paths must answer as an API, not as the SPA. Without this the
// catch-all below returned index.html with a 200 for a mistyped endpoint, so a
// client saw "success" and tried to parse HTML as JSON.
app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Central error handler: nothing reaches the client but a generic message,
// while the real error is logged in full. Must be registered last and must
// take four arguments for Express to recognise it.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  log.error('unhandled_error', err, { method: req.method, path: req.path });
  if (!res.headersSent) res.status(500).json({ ok: false, error: 'Something went wrong.' });
});

const PORT = process.env.PORT || 3000;

// Refuse to start with an unset or placeholder staff PIN — every order,
// customer address and sales figure sits behind it.
if (!assertAdminPinConfigured()) process.exit(1);

app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ✓  Sweet & Crispy server running');
  console.log(`  ✓  Local:   http://localhost:${PORT}`);
  console.log(`  ✓  Network: http://<your-ip>:${PORT}`);
  console.log('');
  // Warns loudly (but does not exit) if the database is missing tables or
  // columns this version of the app needs — see lib/verify-schema.js.
  require('./lib/verify-schema').verifySchema();
});
