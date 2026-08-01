const router = require('express').Router();
const db = require('../db/pool');
const { requireStaff } = require('../lib/auth');
const { route } = require('../lib/log');

// Revenue figures are commercially sensitive — the whole router is staff-only.
router.use(requireStaff);

router.get('/summary', route('sales.summary', async (req, res) => {
  const [[totals]] = await db.query(`
    SELECT
      COUNT(*) AS total_orders,
      COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN total_ec ELSE 0 END), 0) AS gross_revenue,
      COALESCE(AVG(total_ec), 0) AS avg_order,
      SUM(status = 'pending')       AS pending_count,
      SUM(payment_status = 'paid')  AS paid_count
    FROM orders`);
  const [[today]] = await db.query(`
    SELECT COUNT(*) AS orders_today,
           COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN total_ec ELSE 0 END), 0) AS revenue_today
    FROM orders WHERE created_at >= CURDATE() AND created_at < CURDATE() + INTERVAL 1 DAY`);
  res.json({ ok: true, summary: { ...totals, ...today } });
}));

// `limit` is clamped: an unbounded caller-supplied LIMIT is a cheap way to make
// the database do unbounded work.
router.get('/top-items', route('sales.topItems', async (req, res) => {
  const raw = parseInt(req.query.limit, 10);
  const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, 50) : 10;
  const [rows] = await db.query('SELECT * FROM top_items LIMIT ?', [limit]);
  res.json({ ok: true, items: rows });
}));

module.exports = router;
