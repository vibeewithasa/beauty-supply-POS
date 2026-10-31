// Loads the FICTIONAL demonstration dataset (scripts/lib/demo-data.mjs) into a database that was just created for it.
// Everything is written the way the application itself writes it (sale lines with the name as sold, cash movements linked to their
// sale, stock movements, returns and an administrator-authorized settlement), so every screen and report reads it normally.
// One transaction: either the whole demonstration is there or nothing is. The caller must hand a client connected to a NEW database
// (this module refuses a database that already holds users, products or sales).
import { hashPin, PIN_NEW_RE } from "../../src/backend/pin-hash.ts";
import { DAYS, PRODUCTS, USERS, productBySku, lineCents, saleCents } from "./demo-data.mjs";

const money = (cents) => (cents / 100).toFixed(2);

export function validateDemoPins(adminPin, vendorPin) {
  for (const [who, pin] of [["administrador", adminPin], ["vendedor", vendorPin]]) {
    if (typeof pin !== "string" || !PIN_NEW_RE.test(pin)) throw new Error(`El PIN del ${who} debe tener de 6 a 8 dígitos`);
  }
  if (adminPin === vendorPin) throw new Error("El PIN del administrador y el del vendedor deben ser distintos");
}

export async function seedDemo(client, { adminPin, vendorPin, now = new Date() }) {
  validateDemoPins(adminPin, vendorPin);
  const used = (await client.query("select (select count(*) from users)::int u, (select count(*) from products)::int p, (select count(*) from sales)::int s")).rows[0];
  if (used.u + used.p + used.s > 0) throw new Error("La base de demostración debe estar vacía: no se carga sobre datos existentes");

  const at = (daysAgo, [h, m]) => { const d = new Date(now); d.setDate(d.getDate() - daysAgo); d.setHours(h, m, 0, 0); return d; };
  const adminHash = await hashPin(adminPin);
  const vendorHash = await hashPin(vendorPin);
  await client.query("begin");
  try {
    const admin = (await client.query("insert into users(name, pin_hash, role) values($1,$2,'admin') returning id", [USERS.admin, adminHash])).rows[0].id;
    const vendor = (await client.query("insert into users(name, pin_hash, role) values($1,$2,'vendor') returning id", [USERS.vendor, vendorHash])).rows[0].id;

    const stock = new Map();
    const ids = new Map();
    const stocked = at(5, [9, 0]);
    for (const p of PRODUCTS) {
      const id = (await client.query(
        "insert into products(sku,name,price,stock,barcode,category,status,created_at,updated_at) values($1,$2,$3,$4,$5,$6,'active',$7,$7) returning id",
        [p.sku, p.name, money(p.cents), p.stock, p.barcode, p.category, stocked]
      )).rows[0].id;
      ids.set(p.sku, id);
      stock.set(p.sku, p.stock);
      await client.query("insert into inventory_movements(product_id,user_id,type,amount,reason,created_at) values($1,$2,'IN',$3,'Inventario inicial de demostración',$4)", [id, admin, p.stock, stocked]);
    }

    const saleRows = new Map(); // label -> { id, sessionId, lines }
    const returnRows = new Map(); // `${sale label}` -> { id, cents }
    const pendingPayments = []; // { returnLabel, day, at, method }

    for (const d of DAYS) {
      const opened = at(d.day, d.opens);
      const sessionId = (await client.query(
        "insert into cash_sessions(opened_by, opened_at, initial_amount, current_amount, status) values($1,$2,$3,$3,'open') returning id",
        [vendor, opened, money(d.initialCents)]
      )).rows[0].id;
      let balance = d.initialCents;

      // everything that happens in this register, in time order
      const events = [
        ...d.sales.map((s) => ({ t: at(d.day, s.at), kind: "sale", s })),
        ...d.movements.map((m) => ({ t: at(d.day, m.at), kind: "move", m })),
        ...(d.returns ?? []).map((r) => ({ t: at(d.day, r.at), kind: "return", r })),
        ...pendingPayments.filter((p) => p.day === d.day).map((p) => ({ t: at(d.day, p.at), kind: "pay", p })),
      ].sort((a, b) => a.t - b.t);

      for (const e of events) {
        if (e.kind === "sale") {
          const total = saleCents(e.s);
          const sale = (await client.query("insert into sales(user_id,cash_session_id,total,payment_method,created_at) values($1,$2,$3,$4,$5) returning id", [vendor, sessionId, money(total), e.s.method, e.t])).rows[0].id;
          const lines = [];
          for (const [sku, q] of e.s.lines) {
            const p = productBySku(sku);
            const item = (await client.query(
              "insert into sale_items(sale_id,product_id,quantity,unit_price,subtotal,product_name,product_sku) values($1,$2,$3,$4,$5,$6,$7) returning id",
              [sale, ids.get(sku), q, money(p.cents), money(p.cents * q), p.name, p.sku]
            )).rows[0].id;
            lines.push({ sku, q, itemId: item });
            stock.set(sku, stock.get(sku) - q);
            await client.query("insert into inventory_movements(product_id,user_id,type,amount,reason,created_at) values($1,$2,'OUT',$3,$4,$5)", [ids.get(sku), vendor, -q, `Venta #${sale}`, e.t]);
          }
          if (e.s.method === "cash") {
            balance += total;
            await client.query("insert into cash_movements(session_id,user_id,type,amount,reason,sale_id,created_at) values($1,$2,'IN',$3,$4,$5,$6)", [sessionId, vendor, money(total), `Venta #${sale} - Efectivo`, sale, e.t]);
          } else {
            await client.query("insert into cash_movements(session_id,user_id,type,amount,reason,sale_id,created_at) values($1,$2,'IN','0.00',$3,$4,$5)", [sessionId, vendor, `Venta #${sale} - Tarjeta ($${money(total)})`, sale, e.t]);
          }
          saleRows.set(e.s.id, { id: sale, lines });
        } else if (e.kind === "move") {
          balance += e.m.type === "IN" ? e.m.cents : -e.m.cents;
          await client.query("insert into cash_movements(session_id,user_id,type,amount,reason,created_at) values($1,$2,$3,$4,$5,$6)", [sessionId, vendor, e.m.type, money(e.m.cents), e.m.reason, e.t]);
        } else if (e.kind === "return") {
          const sale = saleRows.get(e.r.sale);
          const cents = e.r.lines.reduce((s, l) => s + lineCents(l), 0);
          const ret = (await client.query("insert into returns(sale_id,total_refund,refund_status,reason,processed_by,created_at) values($1,$2,'pending',$3,$4,$5) returning id", [sale.id, money(cents), e.r.reason, vendor, e.t])).rows[0].id;
          for (const [sku, q] of e.r.lines) {
            const line = sale.lines.find((l) => l.sku === sku);
            await client.query("insert into return_items(return_id,sale_item_id,product_id,quantity,refund_amount) values($1,$2,$3,$4,$5)", [ret, line.itemId, ids.get(sku), q, money(productBySku(sku).cents * q)]);
            stock.set(sku, stock.get(sku) + q);
            await client.query("insert into inventory_movements(product_id,user_id,type,amount,reason,created_at) values($1,$2,'IN',$3,$4,$5)", [ids.get(sku), vendor, q, `Devolución #${ret} de Venta #${sale.id}`, e.t]);
          }
          returnRows.set(e.r.sale, { id: ret, saleId: sale.id, cents });
          if (e.r.payment) pendingPayments.push({ returnLabel: e.r.sale, ...e.r.payment });
        } else {
          // a refund paid in cash from THIS register, authorized by the administrator
          const r = returnRows.get(e.p.returnLabel);
          balance -= r.cents;
          const mv = (await client.query("insert into cash_movements(session_id,user_id,type,amount,reason,created_at) values($1,$2,'OUT',$3,$4,$5) returning id", [sessionId, vendor, money(r.cents), `Reembolso en efectivo - Devolución #${r.id} (venta #${r.saleId})`, e.t])).rows[0].id;
          await client.query(
            "insert into refund_settlements(return_id,payment_method,amount,authorized_by,processed_by,paid_at,cash_session_id,cash_movement_id) values($1,'cash',$2,$3,$4,$5,$6,$7)",
            [r.id, money(r.cents), admin, vendor, e.t, sessionId, mv]
          );
          await client.query("update returns set refund_status='paid' where id=$1", [r.id]);
        }
      }
      const closed = at(d.day, d.closes);
      await client.query(
        "update cash_sessions set status='closed', closed_at=$2, closed_by=$3, current_amount=$4, final_amount=$5 where id=$1",
        [sessionId, closed, vendor, money(balance), money(balance + d.countedDiffCents)]
      );
    }
    for (const [sku, n] of stock) await client.query("update products set stock=$2 where id=$1", [ids.get(sku), n]);
    await client.query("commit");
    return { users: 2, products: PRODUCTS.length, sessions: DAYS.length, sales: saleRows.size, returns: returnRows.size };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  }
}
