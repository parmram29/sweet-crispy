const router = require('express').Router();
const db = require('../db/pool');
const { requireStaff } = require('../lib/auth');
const { route } = require('../lib/log');

// GET /api/menu — public. Full available menu, ordered for display.
// Bounded by the size of the menu itself (tens of rows, staff-curated), so it
// is not paginated; if the menu ever grows past a few hundred items this needs
// the same limit/offset treatment as /api/orders.
router.get('/', route('menu.list', async (req, res) => {
  const [rows] = await db.query(
    'SELECT * FROM menu_items WHERE available = 1 ORDER BY category, sort_order, name'
  );
  res.json({ ok: true, items: rows });
}));

// PATCH /api/menu/:id/toggle — staff only: show/hide an item without deleting it.
// Unauthenticated, this let anyone empty the restaurant's menu.
router.patch('/:id/toggle', requireStaff, route('menu.toggle', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'Invalid item id' });
  const [result] = await db.query('UPDATE menu_items SET available = NOT available WHERE id = ?', [id]);
  if (!result.affectedRows) return res.status(404).json({ ok: false, error: 'Menu item not found' });
  res.json({ ok: true });
}));

module.exports = router;
