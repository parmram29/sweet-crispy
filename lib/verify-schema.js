const db = require('../db/pool');

/**
 * Startup sanity check for schema drift.
 *
 * The most common local-setup failure is running a newer version of the app
 * against an older database (e.g. pulling code that added `orders.order_type`
 * or the `payment_events` table without re-running db/schema.sql). Without
 * this check the app boots happily and then throws a 500 the first time a
 * customer tries to place an order — a confusing failure at the worst moment.
 *
 * This verifies the tables and columns the app actually depends on and prints
 * one clear, actionable message at boot instead. It never exits the process:
 * a missing column shouldn't stop staff from viewing existing orders.
 */

const REQUIRED = {
  menu_items:     ['id', 'name', 'category', 'subcategory', 'price_ec', 'price_large_ec', 'available', 'is_signature'],
  orders:         ['id', 'order_ref', 'customer_name', 'phone', 'order_type', 'delivery_address',
                   'subtotal_ec', 'total_ec', 'status', 'payment_method', 'payment_status', 'stripe_session_id'],
  order_items:    ['id', 'order_id', 'item_name', 'size', 'unit_price', 'quantity', 'special_instructions'],
  payment_events: ['id', 'order_id', 'event', 'method', 'amount_ec', 'detail'],
  reservations:   ['id', 'ref', 'guest_name', 'party_size', 'res_date', 'res_time', 'status'],
  settings:       ['key', 'value'],
};

async function verifySchema() {
  const problems = [];
  try {
    const [tableRows] = await db.query(
      'SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()'
    );
    const present = new Set(tableRows.map(r => r.t));

    for (const [table, columns] of Object.entries(REQUIRED)) {
      if (!present.has(table)) { problems.push(`missing table: ${table}`); continue; }
      const [colRows] = await db.query(
        'SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        [table]
      );
      const cols = new Set(colRows.map(r => r.c));
      const missing = columns.filter(c => !cols.has(c));
      if (missing.length) problems.push(`${table} is missing column(s): ${missing.join(', ')}`);
    }

    // Duplicate menu rows mean an older, non-idempotent schema seeded twice.
    if (present.has('menu_items')) {
      const [[dupes]] = await db.query(
        'SELECT COUNT(*) AS n FROM (SELECT name, category FROM menu_items GROUP BY name, category HAVING COUNT(*) > 1) d'
      );
      if (dupes.n > 0) problems.push(`${dupes.n} duplicated menu item(s) — the menu was seeded more than once`);
    }
  } catch (err) {
    console.error('');
    console.error('  ✗  Could not reach the database.');
    console.error(`     ${err.message}`);
    console.error('     Check DB_HOST / DB_USER / DB_PASSWORD / DB_NAME in your .env file,');
    console.error('     and that your MySQL server is running.');
    console.error('');
    return;
  }

  if (!problems.length) return;

  console.error('');
  console.error('  ✗  Your database is out of date with this version of the app:');
  problems.forEach(p => console.error(`       · ${p}`));
  console.error('');
  console.error('     Fix (this wipes local test orders, not your code):');
  console.error('       mysql -u root -p -e "DROP DATABASE sweet_crispy;"');
  console.error('       mysql -u root -p < db/schema.sql');
  console.error('');
  console.error('     Until then, placing an order will fail.');
  console.error('');
}

module.exports = { verifySchema };
