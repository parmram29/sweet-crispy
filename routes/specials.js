const router = require('express').Router();
const db = require('../db/pool');
const { requireStaff } = require('../lib/auth');
const { route } = require('../lib/log');

const MAX_ACTIVE_SPECIALS = 50;

// GET /api/specials — public. Bounded so a runaway insert cannot turn the
// homepage into an unbounded response.
router.get('/', route('specials.list', async (req, res) => {
  const [rows] = await db.query(
    'SELECT * FROM specials WHERE active = 1 ORDER BY created_at DESC LIMIT ?',
    [MAX_ACTIVE_SPECIALS]
  );
  res.json({ ok: true, specials: rows });
}));

// POST /api/specials — staff only.
// Unauthenticated, this was a stored-content injection point: anyone could
// POST arbitrary text that the homepage and the staff dashboard then rendered.
router.post('/', requireStaff, route('specials.create', async (req, res) => {
  const { name, description, category, price_ec, original_ec } = req.body;
  const trimmedName = (name || '').trim().slice(0, 120);
  const price = Number(price_ec);
  if (!trimmedName) return res.status(400).json({ ok: false, error: 'Name is required' });
  if (!Number.isFinite(price) || price < 0 || price > 100000) {
    return res.status(400).json({ ok: false, error: 'Enter a valid price' });
  }
  const original = original_ec === null || original_ec === undefined || original_ec === ''
    ? null
    : Number(original_ec);
  if (original !== null && (!Number.isFinite(original) || original < 0 || original > 100000)) {
    return res.status(400).json({ ok: false, error: 'Enter a valid original price' });
  }

  const [result] = await db.query(
    'INSERT INTO specials (name, description, category, price_ec, original_ec) VALUES (?, ?, ?, ?, ?)',
    [trimmedName, (description || '').trim().slice(0, 500) || null, (category || '').trim().slice(0, 50) || null, price, original]
  );
  const [rows] = await db.query('SELECT * FROM specials WHERE id = ?', [result.insertId]);
  res.status(201).json({ ok: true, special: rows[0] });
}));

// DELETE /api/specials/:id — staff only (soft delete).
router.delete('/:id', requireStaff, route('specials.delete', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'Invalid id' });
  const [result] = await db.query('UPDATE specials SET active = 0 WHERE id = ?', [id]);
  if (!result.affectedRows) return res.status(404).json({ ok: false, error: 'Special not found' });
  res.json({ ok: true });
}));

module.exports = router;
