const router = require('express').Router();
const db = require('../db/pool');
const { makeRef, rateLimit, parsePaging } = require('../lib/security');
const { requireStaff } = require('../lib/auth');
const { log, route } = require('../lib/log');

const MAX_QTY = 20;
const MAX_LINES = 30;

// Resolve a cart (client only sends menu_item_id + quantity + optional size) against
// the database — price and name are NEVER trusted from the client, which prevents
// price tampering from the browser.
async function resolveCart(items) {
  if (!Array.isArray(items) || !items.length) return { error: 'Your cart is empty' };
  if (items.length > MAX_LINES) return { error: 'Too many items in one order' };

  const ids = [...new Set(items.map(i => parseInt(i.menu_item_id)))];
  if (ids.some(id => !Number.isInteger(id))) return { error: 'Invalid item in cart' };

  const [rows] = await db.query(
    `SELECT id, name, price_ec, price_large_ec FROM menu_items WHERE id IN (${ids.map(() => '?').join(',')}) AND available = 1`,
    ids
  );
  const byId = new Map(rows.map(r => [r.id, r]));

  const resolved = [];
  for (const raw of items) {
    const id = parseInt(raw.menu_item_id);
    const qty = parseInt(raw.quantity);
    const menuItem = byId.get(id);
    if (!menuItem) return { error: 'One of the items in your cart is no longer available' };
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) return { error: 'Invalid quantity' };

    let size = null;
    let unit_price = parseFloat(menuItem.price_ec);
    if (menuItem.price_large_ec != null) {
      size = raw.size === 'L' ? 'L' : 'M';
      unit_price = size === 'L' ? parseFloat(menuItem.price_large_ec) : parseFloat(menuItem.price_ec);
    }

    // Special instructions are free text (e.g. "no onions", "extra spicy") —
    // capped in length and never interpreted, just stored and displayed.
    const special_instructions = typeof raw.special_instructions === 'string'
      ? raw.special_instructions.trim().slice(0, 300) || null
      : null;

    resolved.push({
      menu_item_id: id,
      item_name: menuItem.name,
      size,
      unit_price,
      quantity: qty,
      special_instructions,
    });
  }
  return { resolved };
}

/**
 * Attaches line items to a page of orders in ONE query.
 *
 * This previously issued a query per order inside a loop — a classic N+1. At
 * the old page size of 200 a single dashboard load fired 201 round trips, and
 * the staff dashboard polls this on every tab switch.
 */
async function attachItems(orders) {
  if (!orders.length) return;
  const ids = orders.map(o => o.id);
  const [items] = await db.query(
    `SELECT * FROM order_items WHERE order_id IN (${ids.map(() => '?').join(',')})`,
    ids
  );
  const byOrder = new Map(ids.map(id => [id, []]));
  for (const item of items) byOrder.get(item.order_id)?.push(item);
  for (const o of orders) o.items = byOrder.get(o.id) || [];
}

/**
 * Generates an order reference, retrying on the (rare) UNIQUE collision.
 * Without this a collision surfaced to the customer as "Could not save order".
 */
async function makeUniqueRef(conn, prefix, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    const ref = makeRef(prefix);
    const [[hit]] = await conn.query('SELECT 1 AS x FROM orders WHERE order_ref = ? LIMIT 1', [ref]);
    if (!hit) return ref;
  }
  throw new Error('could not allocate a unique order_ref');
}

const ORDER_STATUSES = ['pending', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled'];

// GET /api/orders — staff only. Returns customer names, phones and delivery
// addresses, so it sits behind the staff session. Paginated and bounded.
router.get('/', requireStaff, route('orders.list', async (req, res) => {
  const { status } = req.query;
  if (status && !ORDER_STATUSES.includes(status)) {
    return res.status(400).json({ ok: false, error: 'Invalid status filter' });
  }
  const { limit, offset } = parsePaging(req.query, { defaultLimit: 50, maxLimit: 200 });

  const where = status ? 'WHERE status = ?' : '';
  const params = status ? [status] : [];

  const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM orders ${where}`, params);
  const [orders] = await db.query(
    `SELECT * FROM orders ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  await attachItems(orders);
  res.json({ ok: true, orders, page: { limit, offset, total } });
}));

// GET /api/orders/track/:ref — customer-facing lookup by unguessable reference.
// Public by design (the ref is the capability), so it returns only what the
// customer already knows: never the phone, address, or internal id.
router.get('/track/:ref', route('orders.track', async (req, res) => {
  const [rows] = await db.query(
    `SELECT id, order_ref, status, order_type, payment_method, payment_status,
            subtotal_ec, total_ec, created_at
       FROM orders WHERE order_ref = ?`,
    [req.params.ref]
  );
  if (!rows.length) return res.status(404).json({ ok: false, error: 'Order not found' });
  await attachItems(rows);
  const { id, ...order } = rows[0];
  res.json({ ok: true, order });
}));

// POST /api/orders — create a new order from a cart. Items are re-priced from the
// database on every request. payment_method chooses the next step on the client:
// 'cash' orders are confirmed immediately (pay at pickup/delivery); 'card' orders
// still need a Stripe Checkout Session created via /api/payments/checkout-session.
// order_type 'delivery' requires a delivery_address (length-capped free text).
router.post('/', rateLimit('create-order', 15, 10 * 60 * 1000), route('orders.create', async (req, res) => {
  const { customer_name, phone, notes, items, payment_method } = req.body;
  const name = (customer_name || '').trim();
  const ph = (phone || '').trim();
  if (!name || name.length > 100) return res.status(400).json({ ok: false, error: 'Please enter your name' });
  if (!ph || ph.length > 30) return res.status(400).json({ ok: false, error: 'Please enter a phone number' });
  if (!['card', 'cash'].includes(payment_method)) return res.status(400).json({ ok: false, error: 'Choose a payment method' });

  const order_type = req.body.order_type === 'delivery' ? 'delivery' : 'pickup';
  let delivery_address = null;
  if (order_type === 'delivery') {
    delivery_address = (req.body.delivery_address || '').trim().slice(0, 255);
    if (!delivery_address) return res.status(400).json({ ok: false, error: 'Please enter a delivery address' });
  }

  const { error, resolved } = await resolveCart(items);
  if (error) return res.status(400).json({ ok: false, error });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const total_ec = resolved.reduce((sum, i) => sum + i.unit_price * i.quantity, 0);
    const order_ref = await makeUniqueRef(conn, 'ORD');
    const [orderResult] = await conn.query(
      `INSERT INTO orders (order_ref, customer_name, phone, order_type, delivery_address, notes, subtotal_ec, total_ec, payment_method)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [order_ref, name, ph, order_type, delivery_address, (notes || '').slice(0, 500) || null, total_ec, total_ec, payment_method]
    );
    for (const item of resolved) {
      await conn.query(
        'INSERT INTO order_items (order_id, menu_item_id, item_name, size, unit_price, quantity, special_instructions) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [orderResult.insertId, item.menu_item_id, item.item_name, item.size, item.unit_price, item.quantity, item.special_instructions]
      );
    }
    // Audit trail — metadata only, never card data (see payment_events in db/schema.sql)
    await conn.query(
      'INSERT INTO payment_events (order_id, event, method, amount_ec, detail) VALUES (?, ?, ?, ?, ?)',
      [orderResult.insertId, 'order_created', payment_method, total_ec, order_type]
    );
    await conn.commit();

    const [newOrder] = await conn.query('SELECT * FROM orders WHERE id = ?', [orderResult.insertId]);
    const [newItems] = await conn.query('SELECT * FROM order_items WHERE order_id = ?', [orderResult.insertId]);
    newOrder[0].items = newItems;
    log.info('order_created', { order_ref, order_type, payment_method, total_ec });
    res.status(201).json({ ok: true, order: newOrder[0] });
  } catch (err) {
    await conn.rollback();
    log.error('order_create_failed', err);
    res.status(500).json({ ok: false, error: 'Could not save order' });
  } finally { conn.release(); }
}));

/**
 * PATCH /api/orders/:id/items — staff-only correction of a pending order.
 *
 * Staff-only because there is no customer identity in this system: with no
 * session and a sequential :id, this endpoint previously let an anonymous
 * caller rewrite any pending order. Combined with card checkout that meant a
 * customer could open a Stripe session for EC$40, add EC$500 of items, and pay
 * the original EC$40 — the session amount is fixed when the session is created.
 *
 * The stripe_session_id guard closes that race for good: once a checkout exists,
 * the amount is committed and the line items are frozen.
 */
router.patch('/:id/items', requireStaff, route('orders.editItems', async (req, res) => {
  const { items } = req.body;
  const conn = await db.getConnection();
  try {
    const [[order]] = await conn.query('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!order) return res.status(404).json({ ok: false, error: 'Order not found' });
    if (order.status !== 'pending' || order.payment_status === 'paid') {
      return res.status(409).json({ ok: false, error: 'This order can no longer be edited' });
    }
    if (order.stripe_session_id) {
      return res.status(409).json({
        ok: false,
        error: 'A card payment is already in progress for this order — cancel it before editing.',
      });
    }
    const { error, resolved } = await resolveCart(items);
    if (error) return res.status(400).json({ ok: false, error });

    await conn.beginTransaction();
    const total_ec = resolved.reduce((sum, i) => sum + i.unit_price * i.quantity, 0);
    await conn.query('DELETE FROM order_items WHERE order_id = ?', [order.id]);
    for (const item of resolved) {
      await conn.query(
        'INSERT INTO order_items (order_id, menu_item_id, item_name, size, unit_price, quantity, special_instructions) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [order.id, item.menu_item_id, item.item_name, item.size, item.unit_price, item.quantity, item.special_instructions]
      );
    }
    await conn.query('UPDATE orders SET subtotal_ec = ?, total_ec = ? WHERE id = ?', [total_ec, total_ec, order.id]);
    await conn.query(
      'INSERT INTO payment_events (order_id, event, method, amount_ec, detail) VALUES (?, ?, ?, ?, ?)',
      [order.id, 'order_items_edited', order.payment_method, total_ec, 'edited by staff']
    );
    await conn.commit();

    const [updated] = await conn.query('SELECT * FROM orders WHERE id = ?', [order.id]);
    const [updatedItems] = await conn.query('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
    updated[0].items = updatedItems;
    log.info('order_items_edited', { order_ref: order.order_ref, total_ec });
    res.json({ ok: true, order: updated[0] });
  } catch (err) {
    await conn.rollback();
    log.error('order_edit_failed', err, { order_id: req.params.id });
    res.status(500).json({ ok: false, error: 'Could not update order' });
  } finally { conn.release(); }
}));

// PATCH /api/orders/:id/payment — staff-only: confirm a cash payment was collected.
// Card payments are marked paid exclusively by the Stripe webhook, never from here.
router.patch('/:id/payment', requireStaff, route('orders.markPaid', async (req, res) => {
  const { payment_status } = req.body;
  if (!['paid', 'unpaid'].includes(payment_status)) return res.status(400).json({ ok: false, error: 'Invalid payment status' });

  const [[order]] = await db.query('SELECT id, order_ref, payment_method, total_ec FROM orders WHERE id = ?', [req.params.id]);
  if (!order) return res.status(404).json({ ok: false, error: 'Order not found' });
  if (order.payment_method !== 'cash') return res.status(400).json({ ok: false, error: 'Only cash orders can be marked paid here' });

  await db.query('UPDATE orders SET payment_status = ?, paid_at = ? WHERE id = ?',
    [payment_status, payment_status === 'paid' ? new Date() : null, req.params.id]);
  if (payment_status === 'paid') {
    await db.query(
      'INSERT INTO payment_events (order_id, event, method, amount_ec, detail) VALUES (?, ?, ?, ?, ?)',
      [order.id, 'cash_payment_confirmed', 'cash', order.total_ec, 'confirmed by staff']
    );
    log.info('cash_payment_confirmed', { order_ref: order.order_ref, amount_ec: order.total_ec });
  }
  res.json({ ok: true });
}));

// PATCH /api/orders/:id/status — staff-only kitchen workflow transitions.
router.patch('/:id/status', requireStaff, route('orders.setStatus', async (req, res) => {
  const { status } = req.body;
  if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ ok: false, error: 'Invalid status' });
  const [result] = await db.query('UPDATE orders SET status = ? WHERE id = ?', [status, req.params.id]);
  if (!result.affectedRows) return res.status(404).json({ ok: false, error: 'Order not found' });
  res.json({ ok: true });
}));

module.exports = router;
