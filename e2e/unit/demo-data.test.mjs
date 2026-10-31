import test from "node:test";
import assert from "node:assert/strict";
import { DAYS, PRODUCTS, USERS, ean13, expectedTotals, lineCents, productBySku, saleCents } from "../../scripts/lib/demo-data.mjs";
import { validateDemoPins } from "../../scripts/lib/demo-seed.mjs";

test("EAN-13 check digits are correct (known examples)", () => {
  assert.equal(ean13("400638133393"), "4006381333931");
  assert.equal(ean13("036000291452"), "0360002914522");
  assert.throws(() => ean13("98765"));
});

test("products: unique SKUs with the DEMO- marker, positive prices and stock, valid unique internal barcodes", () => {
  assert.equal(PRODUCTS.length, 24);
  assert.equal(new Set(PRODUCTS.map((p) => p.sku)).size, PRODUCTS.length);
  assert.ok(PRODUCTS.every((p) => p.sku.startsWith("DEMO-") && p.cents > 0 && Number.isInteger(p.cents) && p.stock > 0));
  const codes = PRODUCTS.filter((p) => p.barcode).map((p) => p.barcode);
  assert.ok(codes.length >= 4, "a few products carry a barcode for the scanner demonstration");
  assert.equal(new Set(codes).size, codes.length);
  for (const c of codes) {
    assert.match(c, /^20\d{11}$/, "GS1 internal-use prefix 20: it can never be a real product's code");
    assert.equal(ean13(c.slice(0, 12)), c);
  }
});

test("the dataset invents no commercial information: no contact data, links or tax ids, and only characters every Windows cluster stores", () => {
  const text = JSON.stringify({ PRODUCTS, DAYS, USERS });
  assert.doesNotMatch(text, /https?:|www\.|@|\b\d{3}[-\s]\d{3,4}[-\s]\d{4}\b|\bRFC\b/i);
  for (const ch of text) assert.ok(ch.codePointAt(0) <= 0xff, "outside Latin-1: " + ch);
  assert.deepEqual(USERS, { admin: "Administrador Demo", vendor: "Vendedor Demo" });
  assert.ok(PRODUCTS.every((p) => !/leal/i.test(p.name)), "no product pretends to be the store's own brand");
});

test("every sale and return refers to real products and never returns more than was sold", () => {
  const sold = new Map();
  for (const d of DAYS) {
    for (const s of d.sales) {
      assert.ok(s.lines.length >= 1 && ["cash", "card"].includes(s.method));
      for (const [sku, q] of s.lines) { productBySku(sku); assert.ok(Number.isInteger(q) && q > 0); }
      sold.set(s.id, s);
    }
  }
  for (const d of DAYS) {
    for (const r of d.returns ?? []) {
      const s = sold.get(r.sale);
      assert.ok(s, "return of an unknown sale " + r.sale);
      for (const [sku, q] of r.lines) assert.ok((s.lines.find((l) => l[0] === sku)?.[1] ?? 0) >= q, `${r.sale}/${sku}`);
    }
  }
});

test("days are chronological, one register each, with a shortage on one day, a paid refund whose payment date differs, and a pending return", () => {
  assert.deepEqual(DAYS.map((d) => d.day), [3, 2, 1]);
  assert.ok(DAYS.some((d) => d.countedDiffCents < 0), "one closing with a difference");
  const returns = DAYS.flatMap((d) => (d.returns ?? []).map((r) => ({ ...r, returnDay: d.day })));
  assert.ok(returns.some((r) => r.payment && r.payment.day !== r.returnDay && r.payment.method === "cash"), "paid later, in cash");
  assert.ok(returns.some((r) => r.payment === null), "one pending");
  for (const d of DAYS) {
    const events = [...d.sales.map((s) => s.at), ...d.movements.map((m) => m.at), ...(d.returns ?? []).map((r) => r.at)];
    for (const [h, m] of events) assert.ok(h * 60 + m > d.opens[0] * 60 + d.opens[1] && h * 60 + m < d.closes[0] * 60 + d.closes[1], "event outside the opening hours of its register");
  }
});

test("the expected figures are what the definitions add up to", () => {
  const t = expectedTotals();
  assert.equal(t.products, 24);
  assert.equal(t.sales, 12);
  assert.equal(t.returns, 2);
  assert.equal(t.cashSalesCents + t.cardSalesCents, DAYS.flatMap((d) => d.sales).reduce((s, x) => s + saleCents(x), 0));
  assert.equal(t.paidCashCents, lineCents(["DEMO-SE-100", 1]));
  assert.equal(t.pendingCents, lineCents(["DEMO-LIGAS", 2]));
  // register balances before the closing difference: 500 + 758 - 100 ; 400 + 50 + 802 ; 450 + 731 - 215
  assert.deepEqual(t.sessionBalances, { 3: 115800, 2: 125200, 1: 96600 });
  assert.ok(Object.values(t.stock).every((n) => n >= 0), "no negative stock");
  assert.equal(t.stock["DEMO-SE-100"], 14, "sold 1, returned 1");
  assert.equal(t.stock["DEMO-LIGAS"], 38, "sold 4, returned 2");
  assert.ok(Object.values(t.stock).filter((n) => n < 10).length >= 2, "a couple of low-stock products for the dashboard");
});

test("demonstration PINs are validated: 6 to 8 digits each and different from each other", () => {
  assert.doesNotThrow(() => validateDemoPins("483920", "715304"));
  for (const [a, v] of [["9183", "715304"], ["483920", "12"], ["483920", "483920"], ["abcdef", "715304"], [undefined, "715304"], ["483920", null], ["918374651", "715304"]]) {
    assert.throws(() => validateDemoPins(a, v), undefined, JSON.stringify([a, v]));
  }
});
