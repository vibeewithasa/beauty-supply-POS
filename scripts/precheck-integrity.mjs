// READ-ONLY pre-flight for the integrity migrations (0004 sales/cash/inventory, 0005 returns). Run it BEFORE the app (or db:migrate)
// touches an existing database:
//
//   node scripts/precheck-integrity.mjs                 # database from DATABASE_URL (.env)
//   node scripts/precheck-integrity.mjs --database=name # same server, another database (e.g. a restored copy)
//
// It only issues SELECTs inside a READ ONLY transaction and prints counts, never row contents or credentials.
// Exit code 0: nothing blocks the migration. Exit code 1: at least one BLOCKER (migration would fail and roll back).
import "dotenv/config";
import pg from "pg";

const arg = process.argv.find((a) => a.startsWith("--database="));
const url = new URL(process.env.DATABASE_URL ?? "");
if (arg) url.pathname = "/" + arg.slice("--database=".length);
const client = new pg.Client({ connectionString: url.toString(), application_name: "precheck_integrity" });

// [label, kind, SQL returning one integer `n`]. BLOCKER = the migration's constraint would be violated.
const CHECKS = [
  ["products with negative stock", "BLOCKER", "select count(*)::int n from products where stock < 0"],
  ["products with negative price", "BLOCKER", "select count(*)::int n from products where price < 0"],
  ["products already 'deleted' that still hold stock (only possible if the enum value was added earlier)", "BLOCKER", "select count(*)::int n from products where status::text = 'deleted' and stock <> 0"],
  ["sale_items with quantity <= 0", "BLOCKER", "select count(*)::int n from sale_items where quantity <= 0"],
  ["sale_items with negative amounts", "BLOCKER", "select count(*)::int n from sale_items where unit_price < 0 or subtotal < 0"],
  ["sales with negative total", "BLOCKER", "select count(*)::int n from sales where total < 0"],
  ["cash_movements with negative amount", "BLOCKER", "select count(*)::int n from cash_movements where amount < 0"],
  ["cash_sessions with negative initial/current/final amount", "BLOCKER", "select count(*)::int n from cash_sessions where initial_amount < 0 or current_amount < 0 or final_amount < 0"],
  ["more than one cash session without closed_at (unique open session)", "BLOCKER", "select greatest(count(*) - 1, 0)::int n from cash_sessions where closed_at is null"],
  // cash_sessions_state_coherent, case by case. 'effective' status = what the migration's reconciliation
  // UPDATE leaves behind (closed_at set + status 'open' becomes 'closed'); the rest must already be coherent.
  ["cash sessions with status 'closed' but no closed_at (not reconcilable)", "BLOCKER", "select count(*)::int n from cash_sessions where status = 'closed' and closed_at is null"],
  ["cash sessions closed (closed_at set) but missing closed_by or final_amount", "BLOCKER", "select count(*)::int n from cash_sessions where closed_at is not null and (closed_by is null or final_amount is null)"],
  ["cash sessions open (no closed_at) but carrying closed_by or final_amount", "BLOCKER", "select count(*)::int n from cash_sessions where closed_at is null and status = 'open' and (closed_by is not null or final_amount is not null)"],
  ["cash sessions that would violate cash_sessions_state_coherent after reconciliation (mirror of the SQL constraint)", "BLOCKER", "select count(*)::int n from cash_sessions where not (((case when closed_at is not null and status = 'open' then 'closed' else status::text end) = 'open' and closed_at is null and closed_by is null and final_amount is null) or ((case when closed_at is not null and status = 'open' then 'closed' else status::text end) = 'closed' and closed_at is not null and closed_by is not null and final_amount is not null))"],
  ["sale_items -> sales orphans", "BLOCKER", "select count(*)::int n from sale_items x left join sales s on s.id = x.sale_id where s.id is null"],
  ["sale_items -> products orphans", "BLOCKER", "select count(*)::int n from sale_items x left join products p on p.id = x.product_id where p.id is null"],
  ["sales -> cash_sessions orphans", "BLOCKER", "select count(*)::int n from sales x left join cash_sessions c on c.id = x.cash_session_id where x.cash_session_id is not null and c.id is null"],
  ["cash_movements -> cash_sessions orphans", "BLOCKER", "select count(*)::int n from cash_movements x left join cash_sessions c on c.id = x.session_id where c.id is null"],
  ["inventory_movements -> products orphans", "BLOCKER", "select count(*)::int n from inventory_movements x left join products p on p.id = x.product_id where p.id is null"],
  ["deleted_products_log -> products orphans", "BLOCKER", "select count(*)::int n from deleted_products_log x left join products p on p.id = x.product_id where p.id is null"],
  // migration 0005 (returns)
  ["returns -> sales orphans", "BLOCKER", "select count(*)::int n from returns x left join sales s on s.id = x.sale_id where s.id is null"],
  ["return_items -> returns orphans", "BLOCKER", "select count(*)::int n from return_items x left join returns r on r.id = x.return_id where r.id is null"],
  ["return_items -> sale_items orphans", "BLOCKER", "select count(*)::int n from return_items x left join sale_items s on s.id = x.sale_item_id where s.id is null"],
  ["return_items -> products orphans", "BLOCKER", "select count(*)::int n from return_items x left join products p on p.id = x.product_id where p.id is null"],
  ["return_items with quantity <= 0", "BLOCKER", "select count(*)::int n from return_items where quantity <= 0"],
  ["return_items or returns with negative amounts", "BLOCKER", "select ((select count(*) from return_items where refund_amount < 0) + (select count(*) from returns where total_refund < 0))::int as n"],
  ["duplicate (return_id, sale_item_id) lines in return_items", "BLOCKER", "select count(*)::int n from (select 1 from return_items group by return_id, sale_item_id having count(*) > 1) d"],
  ["sale lines already returned beyond what was sold (not a constraint; review the data)", "INFO", "select count(*)::int n from (select s.id from sale_items s join return_items r on r.sale_item_id = s.id group by s.id, s.quantity having sum(r.quantity) > s.quantity) d"],
  ["existing returns (migration 0005 marks them refund_status='legacy_unspecified', never 'paid')", "INFO", "select count(*)::int n from returns"],
  ["cash sessions closed but status still 'open' (the migration reconciles them)", "INFO", "select count(*)::int n from cash_sessions where closed_at is not null and status = 'open'"],
];

try {
  await client.connect();
  await client.query("BEGIN READ ONLY");
  const db = (await client.query("select current_database() d")).rows[0].d;
  const applied = await client.query("select count(*)::int n from drizzle.__drizzle_migrations").then((r) => r.rows[0].n, () => null);
  console.log(`database: ${db} | drizzle migrations applied: ${applied ?? "n/a"}`);
  let blockers = 0;
  for (const [label, kind, sql] of CHECKS) {
    const n = (await client.query(sql)).rows[0].n;
    const flag = n === 0 ? "ok     " : kind === "BLOCKER" ? "BLOCKER" : "info   ";
    if (n > 0 && kind === "BLOCKER") blockers++;
    console.log(`${flag} ${String(n).padStart(6)}  ${label}`);
  }
  await client.query("ROLLBACK");
  console.log(blockers ? `\n${blockers} blocker(s): fix or decide on this data before migrating (the migration would roll back).` : "\nNo blockers: the integrity migrations are expected to apply. Take a pg_dump backup first.");
  process.exitCode = blockers ? 1 : 0;
} catch (e) {
  console.error("precheck failed:", String(e.message).replace(/postgres(ql)?:\/\/\S+/g, "postgres://***"));
  process.exitCode = 2;
} finally {
  await client.end().catch(() => {});
}
