# Sweet & Crispy — Order, Pay & Reserve

A family-run pizzeria & kitchen site for Grenada. Node/Express + MySQL backend,
vanilla ES-module frontend (no bundler, no framework — deliberately, for a
small single-location business this keeps the whole stack readable and cheap
to host). Orders support pickup or delivery (with a required, length-capped
delivery address). Stripe Checkout handles card payments; cash is settled on
pickup/delivery and confirmed by staff. Every payment-related event lands in
an append-only `payment_events` audit table — metadata only, never card data.

## Homepage photos

Two photo slots degrade gracefully to built-in illustrations until real
photos exist. To use real photos, drop two JPGs in `public/images/`:

- `public/images/hero-pizza.jpg` — the brand-card photo (a great pizza shot)
- `public/images/kitchen.jpg` — the "Our Story" photo (e.g. the restaurant interior)

No code changes needed; the site detects them automatically
(`public/js/pages/home-page.js::bindPhotoFallback`).

## Project layout

```
server.js              Express app: security headers, route mounting, static hosting
lib/security.js         makeRef() (unguessable order/reservation refs), rateLimit()
db/
  schema.sql             Full schema + seed data (56 menu items)
  pool.js                 mysql2 connection pool
routes/
  auth.js                 Staff PIN check
  menu.js                  Public menu list + staff show/hide toggle
  orders.js                 Cart → order creation, editing, status, cash payment confirmation
  payments.js                Stripe Checkout session creation + webhook handler
  reservations.js              Table booking + time-slot capacity logic
  specials.js                   "Today's Special" homepage feature
  sales.js                       Revenue/report queries for the staff dashboard
public/
  index.html               Markup only — no inline <style>/<script>, no onclick=""
  css/style.css             Full stylesheet, sectioned by page/component
  js/
    app.js                   Entry point — instantiates every service/page class and boots
    services/
      api-client.js           ApiClient class — one fetch() wrapper the whole app shares
      cart.js                   Cart class — cart state + behaviour, no DOM
      menu-store.js               MenuStore class — loads/holds the menu + payment config
      format.js                    money/date formatting + escapeHtml()
      whatsapp.js                   wa.me link builder
    ui/
      toast.js                  Toast class (wraps the #toast element)
      router.js                  Router class (page switching, nav highlighting)
      footer.js                   shared footer markup
    pages/
      home-page.js               HomePage class
      about-page.js                AboutPage class
      order-page.js                 OrderPage class — menu browsing, cart, checkout
      reserve-page.js                ReservePage class — table booking flow
      pay-page.js                     PayPage class — owns the Order/Reserve tab switch
      admin-page.js                    AdminPage class — staff dashboard
```

Everything under `public/js/` is a native ES module (`import`/`export`,
loaded via `<script type="module" src="/js/app.js">` — no bundler). Each
class only depends on what's passed into its constructor (an `ApiClient`, a
`MenuStore`, a `Cart`, a `Toast`), so any of them can be understood, tested,
or reused without the rest of the app. Every page class owns exactly one
container element and wires **one delegated event listener** on it — dynamic
content is rendered with `data-action="..."` attributes instead of inline
`onclick=""`, and the listener reads `event.target.closest('[data-action]')`
to dispatch. That pattern is what makes the strict `script-src 'self'` CSP
in `server.js` possible (see below).

## Local setup

```bash
cp .env.example .env        # fill in DB credentials, ADMIN_PIN, Stripe keys
mysql -u root -p < db/schema.sql
npm install
npm run dev                  # nodemon, or `npm start` for plain node
```

`db/schema.sql` is idempotent — safe to run repeatedly. Menu seeds use
`INSERT IGNORE` against a `UNIQUE KEY (name, category)`, so re-running never
duplicates items. (If a database from an older schema version already has
duplicates, drop and recreate it once:
`mysql -u root -p -e "DROP DATABASE sweet_crispy;" && mysql -u root -p < db/schema.sql`.)

The app runs and serves the full frontend even without Stripe configured —
card payment attempts return a clear "not configured yet, choose cash"
message instead of failing silently (see `GET /api/payments/config`).

## Payments: how the security boundary actually works

- **Card payments never touch this server.** `POST /api/payments/checkout-session`
  creates a Stripe-hosted Checkout Session and returns its URL; the browser is
  redirected there directly. Card numbers are entered on Stripe's page. This
  keeps the app in PCI DSS **SAQ A** scope (the lightest self-assessment tier)
  instead of SAQ D, because we never receive, transmit, or store cardholder data.
- **Prices are never trusted from the client.** Every order line is re-priced
  from `menu_items` in `routes/orders.js::resolveCart()` before it's persisted
  or sent to Stripe. A tampered `fetch()` call claiming a $60 pizza costs $1
  is simply ignored — the server looks up the real price by `menu_item_id`.
- **Only the Stripe webhook marks a card order paid.** `routes/payments.js`
  verifies the `Stripe-Signature` header against `STRIPE_WEBHOOK_SECRET`
  before trusting an event — the success redirect the customer's browser
  hits is purely cosmetic and never itself flips `payment_status`. This
  closes the gap where someone could load the "payment successful" URL
  without having actually paid.
- **Cash orders** are marked paid only by staff, via `PATCH /api/orders/:id/payment`,
  which refuses to touch a `card` order (that field is Stripe-webhook-only).
- **No card data is ever collected or stored — by design, not just by policy.**
  There is no input anywhere in this codebase that accepts a card number, and
  no column anywhere that could hold one. The `payment_events` table is the
  transaction log: order created, checkout session opened, webhook confirmed,
  cash confirmed — amounts, methods, Stripe session/intent IDs, timestamps.
  That is everything a reconciliation or dispute needs, with none of the PCI
  DSS SAQ D liability that storing card data would create. If anyone ever
  proposes "just save the card details in the database," the correct answer
  is no — route them to this paragraph.
- **Secrets** (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `ADMIN_PIN`, DB
  credentials) live only in `.env`, which is git-ignored. The frontend only
  ever learns `cardPaymentsEnabled: boolean` from `/api/payments/config` —
  the secret key itself is constructed lazily server-side and never serialized
  to a response.

## Staff authentication — the authorization boundary

`POST /api/auth/login` exchanges the staff PIN for an opaque session token
delivered as an `HttpOnly; SameSite=Strict` cookie; every staff-only route is
wrapped in `requireStaff` (`lib/auth.js`) and returns 401 without it. Sessions
live in memory with an 8-hour TTL, so a restart signs staff out — acceptable for
a single-instance deployment, and the reason a multi-instance deployment must
move this to a shared store.

Also enforced here: constant-time PIN comparison, login rate limiting (8
attempts / 15 min — a short PIN is otherwise brute-forceable in seconds),
server-side session destruction on logout, and a boot-time refusal to start
with a missing or placeholder `ADMIN_PIN`.

**Public by design:** the menu, specials, availability slots, order creation,
reservation creation, and `GET /api/orders/track/:ref` (the unguessable
reference is the capability — it returns no phone, address, or internal id).
**Everything else is staff-only.**

## Running the tests

```bash
npm test        # node --test, no additional dependencies
```

Covers PIN verification (including fail-closed when unconfigured, and rejecting
prefix matches), session lifecycle, the `requireStaff` middleware, rate-limiter
windowing and per-client isolation, and pagination clamping.

## Other security decisions worth knowing about

- **SQL injection**: every query uses `mysql2` parameterized placeholders
  (`?`), including the dynamic `IN (...)` list in `resolveCart()`, which is
  built with a matching number of `?` placeholders rather than string-interpolated.
- **Unguessable references**: order/reservation refs (`ORD-xxxx`, `RES-xxxx`)
  use `crypto.randomBytes` (`lib/security.js`), not sequential IDs, so one
  reference can't be used to enumerate/guess another customer's order.
- **Rate limiting**: order creation and checkout-session creation are
  rate-limited per IP (`lib/security.js::rateLimit`) to blunt scripted abuse.
  It's an in-memory fixed-window limiter — fine for a single-instance deploy;
  a multi-instance deployment would need a shared store (Redis) instead.
- **Stored-XSS defense**: customer-supplied text (name, phone, notes, special
  instructions) is rendered into the staff dashboard via `innerHTML`. Every
  such value is passed through `escapeHtml()` (`public/js/services/format.js`)
  before interpolation — see the comment there for why this matters.
- **CSP**: `script-src 'self'` with no `unsafe-inline` — real, not just
  documented as a trade-off — because the frontend has no inline event
  handlers left (see the event-delegation pattern above). `style-src` still
  allows `'unsafe-inline'` for one-off inline `style=""` layout tweaks in the
  markup, a much lower-severity allowance since CSS injection can't execute
  arbitrary JS. `frame-ancestors 'none'` blocks framing; no third-party
  script/font/connect origins are allowed beyond Google Fonts.
- **Request size limits**: JSON/urlencoded bodies are capped at 100kb.
- **Bounded collections**: `GET /api/orders` and `GET /api/reservations` are
  paginated with a server-side ceiling (`parsePaging`), and return a
  `{limit, offset, total}` envelope. A client cannot request the whole table.
- **Indexes**: declared inline in `db/schema.sql` (MySQL has no
  `CREATE INDEX IF NOT EXISTS`, and the schema must stay re-runnable). Without
  `idx_orders_stripe_session` every Stripe webhook full-scans `orders`.
- **Booking capacity** is enforced inside a transaction with `SELECT … FOR
  UPDATE`. The previous read-then-insert could overbook a slot when two people
  booked simultaneously.
- **Accessibility is treated as correctness, not styling**: controls that were
  click-handling `<div>`s (payment/pickup tiles, menu section headers, date and
  time slots) are real `<button>`s with `aria-pressed` / `aria-expanded`, the
  toast is an `aria-live` region, and full slots use the native `disabled`
  state rather than looking disabled.
- **`TRUST_PROXY`**: set it only when running behind a reverse proxy. Unset,
  every client behind that proxy shares one rate-limit bucket; set when there
  is no proxy, clients can spoof `X-Forwarded-For` to evade the limit.
- **Admin PIN gate**: intentionally a shared-PIN model (`routes/auth.js`),
  appropriate for one small team sharing one dashboard — not a
  multi-user/role permission system. If individual staff logins are ever
  needed, that's a session/JWT-based rework, not a client-side check.

## Menu data model

`menu_items.category` is `'pizza'` or `'food'` — the two ordering tabs.
`subcategory` groups items within a tab (e.g. "Stuffed Crust", "Burgers") and
drives the collapsible dropdown sections on the ordering page. Stuffed-crust
pizzas carry both `price_ec` (Medium) and `price_large_ec` (Large); everything
else has a single price. `order_items` snapshots `item_name`/`unit_price` (and
`special_instructions`) at order time, so a later menu price change never
rewrites history — `menu_item_id` is kept as a reference but order rows
survive a menu item being deleted (`ON DELETE SET NULL`).

## Deploying

1. Provision MySQL, run `db/schema.sql`.
2. Set real environment variables (see `.env.example`) — especially
   `STRIPE_SECRET_KEY`/`STRIPE_PUBLISHABLE_KEY`/`STRIPE_WEBHOOK_SECRET` from
   your Stripe dashboard, and `CLIENT_URL` set to your real domain (used to
   build the Stripe redirect URLs).
3. In the Stripe dashboard, add a webhook endpoint at
   `https://<your-domain>/api/payments/webhook` subscribed to
   `checkout.session.completed`, and copy its signing secret into
   `STRIPE_WEBHOOK_SECRET`.
4. Serve over HTTPS (required for both Stripe and for `helmet`'s HSTS header
   to mean anything) — terminate TLS at your load balancer/reverse proxy if
   Node isn't handling it directly.
