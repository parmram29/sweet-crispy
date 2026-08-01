const router = require('express').Router();
const db     = require('../db/pool');
const { makeRef, rateLimit, parsePaging } = require('../lib/security');
const { requireStaff } = require('../lib/auth');
const { log, route } = require('../lib/log');

const RES_STATUSES = ['confirmed', 'cancelled', 'seated', 'no-show'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HH_MM = /^\d{2}:\d{2}$/;
const MAX_PARTY = 30;

/**
 * GET /api/reservations — staff only, paginated.
 *
 * This returns guest names, phone numbers and notes. It was unauthenticated
 * AND had no LIMIT, so a single anonymous request dumped the restaurant's
 * entire booking history — a privacy breach and an unbounded query in one.
 */
router.get('/', requireStaff, route('reservations.list', async (req, res) => {
  const { date, status } = req.query;
  if (date && !ISO_DATE.test(date)) return res.status(400).json({ ok: false, error: 'Invalid date' });
  if (status && !RES_STATUSES.includes(status)) return res.status(400).json({ ok: false, error: 'Invalid status' });
  const { limit, offset } = parsePaging(req.query, { defaultLimit: 100, maxLimit: 200 });

  let where = 'WHERE 1=1';
  const params = [];
  if (date)   { where += ' AND res_date = ?'; params.push(date); }
  if (status) { where += ' AND status = ?';   params.push(status); }

  const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM reservations ${where}`, params);
  const [rows] = await db.query(
    `SELECT * FROM reservations ${where} ORDER BY res_date ASC, res_time ASC, id ASC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  res.json({ ok: true, reservations: rows, page: { limit, offset, total } });
}));

// GET /api/reservations/slots?date=YYYY-MM-DD — public availability lookup.
router.get('/slots', route('reservations.slots', async (req, res) => {
  const { date } = req.query;
  if (!date || !ISO_DATE.test(date)) return res.status(400).json({ ok: false, error: 'A valid date is required' });

  const [settingRows] = await db.query(
    "SELECT `key`, `value` FROM settings WHERE `key` IN ('max_covers_per_slot','res_open_time','res_close_time')"
  );
  const settings = Object.fromEntries(settingRows.map(r => [r.key, r.value]));
  const maxCovers = parseInt(settings.max_covers_per_slot, 10) || 20;
  const [openH] = (settings.res_open_time || '11:00').split(':').map(Number);
  const [closeH] = (settings.res_close_time || '21:30').split(':').map(Number);

  const [booked] = await db.query(
    `SELECT res_time, SUM(party_size) AS booked
       FROM reservations
      WHERE res_date = ? AND status NOT IN ('cancelled','no-show')
      GROUP BY res_time`,
    [date]
  );
  const bookedMap = {};
  booked.forEach(b => { bookedMap[b.res_time] = parseInt(b.booked, 10); });

  const slots = [];
  for (let h = openH; h <= closeH; h++) {
    for (const m of [0, 30]) {
      const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      const remaining = maxCovers - (bookedMap[time] || 0);
      slots.push({ time, remaining, available: remaining > 0 });
    }
  }
  res.json({ ok: true, slots, maxCovers });
}));

/**
 * POST /api/reservations — public booking.
 *
 * Capacity is enforced inside a transaction with SELECT ... FOR UPDATE. The
 * previous read-then-insert had a lost-update race: two concurrent bookings
 * both read the same "booked" count and both passed the capacity check, so a
 * slot could be overbooked past max_covers_per_slot. The row lock serialises
 * bookings for a given date+time.
 */
router.post('/', rateLimit('create-reservation', 10, 10 * 60 * 1000), route('reservations.create', async (req, res) => {
  const { guest_name, phone, party_size, res_date, res_time, notes } = req.body;
  const name = (guest_name || '').trim().slice(0, 100);
  const party = parseInt(party_size, 10);

  if (!name) return res.status(400).json({ ok: false, error: 'Please enter your name' });
  if (!Number.isInteger(party) || party < 1 || party > MAX_PARTY) {
    return res.status(400).json({ ok: false, error: `Party size must be between 1 and ${MAX_PARTY}` });
  }
  if (!res_date || !ISO_DATE.test(res_date)) return res.status(400).json({ ok: false, error: 'Please choose a valid date' });
  if (!res_time || !HH_MM.test(res_time)) return res.status(400).json({ ok: false, error: 'Please choose a valid time' });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[setting]] = await conn.query(
      "SELECT `value` FROM settings WHERE `key` = 'max_covers_per_slot' FOR UPDATE"
    );
    const maxCovers = parseInt(setting?.value, 10) || 20;

    const [[{ booked }]] = await conn.query(
      `SELECT COALESCE(SUM(party_size), 0) AS booked
         FROM reservations
        WHERE res_date = ? AND res_time = ? AND status NOT IN ('cancelled','no-show')
        FOR UPDATE`,
      [res_date, res_time]
    );

    if ((parseInt(booked, 10) + party) > maxCovers) {
      await conn.rollback();
      return res.status(409).json({ ok: false, error: 'Sorry, that time slot is full. Please choose another time.' });
    }

    const ref = makeRef('RES');
    const [result] = await conn.query(
      `INSERT INTO reservations (ref, guest_name, phone, party_size, res_date, res_time, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [ref, name, (phone || '').trim().slice(0, 30) || null, party, res_date, res_time, (notes || '').slice(0, 500) || null]
    );
    await conn.commit();

    const [rows] = await conn.query('SELECT * FROM reservations WHERE id = ?', [result.insertId]);
    log.info('reservation_created', { ref, res_date, res_time, party });
    res.status(201).json({ ok: true, reservation: rows[0] });
  } catch (err) {
    await conn.rollback();
    log.error('reservation_create_failed', err);
    res.status(500).json({ ok: false, error: 'Could not save reservation' });
  } finally { conn.release(); }
}));

// PATCH /api/reservations/:id/status — staff only.
router.patch('/:id/status', requireStaff, route('reservations.setStatus', async (req, res) => {
  const { status } = req.body;
  if (!RES_STATUSES.includes(status)) return res.status(400).json({ ok: false, error: 'Invalid status' });
  const [result] = await db.query('UPDATE reservations SET status = ? WHERE id = ?', [status, req.params.id]);
  if (!result.affectedRows) return res.status(404).json({ ok: false, error: 'Reservation not found' });
  res.json({ ok: true });
}));

// GET /api/reservations/admin/settings — staff only.
router.get('/admin/settings', requireStaff, route('reservations.getSettings', async (req, res) => {
  const [rows] = await db.query('SELECT * FROM settings');
  const s = {};
  rows.forEach(r => { s[r.key] = r.value; });
  res.json({ ok: true, settings: s });
}));

// PATCH /api/reservations/admin/settings — staff only. Controls how many covers
// the restaurant accepts per slot; unauthenticated this let anyone set capacity
// to 0 (refusing all bookings) or to a number the kitchen cannot serve.
router.patch('/admin/settings', requireStaff, route('reservations.setSettings', async (req, res) => {
  const raw = parseInt(req.body.max_covers_per_slot, 10);
  if (!Number.isInteger(raw) || raw < 1 || raw > 500) {
    return res.status(400).json({ ok: false, error: 'Max covers must be between 1 and 500' });
  }
  await db.query(
    "INSERT INTO settings (`key`, `value`) VALUES ('max_covers_per_slot', ?) ON DUPLICATE KEY UPDATE `value` = ?",
    [String(raw), String(raw)]
  );
  log.info('capacity_updated', { max_covers_per_slot: raw });
  res.json({ ok: true });
}));

module.exports = router;
