// FICTIONAL demonstration dataset for presenting the POS. Nothing here is real: the products, prices, stock and the three
// "previous days" are made up so that every screen has something to show (history, reports, register history, a paid cash refund
// whose payment date differs from its return date, and one return still pending). No commercial data of any store is invented:
// no address, phone, tax id, logo or slogan (the business settings are left exactly as the system creates them).
//
// Pure data and helpers (no database access): used by scripts/lib/demo-seed.mjs and covered by unit tests.

export const DEMO_MARKER = "DEMO-";

/** EAN-13 check digit for the first 12 digits. */
export function ean13(first12) {
  if (!/^\d{12}$/.test(first12)) throw new Error("12 digits expected");
  const sum = [...first12].reduce((s, d, i) => s + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return first12 + String((10 - (sum % 10)) % 10);
}
/** In-store barcodes use the 20-29 prefix reserved by GS1 for internal numbering: they can never collide with a real product. */
const barcode = (n) => ean13("2000000" + String(n).padStart(5, "0"));

// price in cents, initial stock, category. `bar: true` gives the product a barcode (for the scanner demonstration).
export const PRODUCTS = [
  { sku: "DEMO-SH-500", name: "Shampoo Hidratante 500 ml", cents: 12900, stock: 30, category: "Cabello", bar: true },
  { sku: "DEMO-AC-500", name: "Acondicionador Hidratante 500 ml", cents: 13500, stock: 28, category: "Cabello", bar: true },
  { sku: "DEMO-MA-250", name: "Mascarilla Reparadora 250 g", cents: 18900, stock: 18, category: "Tratamientos" },
  { sku: "DEMO-SE-100", name: "Sérum Capilar Brillo 100 ml", cents: 21500, stock: 14, category: "Tratamientos", bar: true },
  { sku: "DEMO-OL-30", name: "Aceite de Argán 30 ml", cents: 24500, stock: 9, category: "Tratamientos" },
  { sku: "DEMO-SP-250", name: "Spray Termoprotector 250 ml", cents: 16500, stock: 16, category: "Cabello" },
  { sku: "DEMO-GE-250", name: "Gel Fijador 250 ml", cents: 8900, stock: 25, category: "Cabello" },
  { sku: "DEMO-CE-60", name: "Cera Modeladora 60 g", cents: 9900, stock: 20, category: "Cabello" },
  { sku: "DEMO-TI-71", name: "Tinte Rubio Ceniza 7.1", cents: 11900, stock: 22, category: "Color", bar: true },
  { sku: "DEMO-TI-50", name: "Tinte Castaño Claro 5.0", cents: 11900, stock: 22, category: "Color" },
  { sku: "DEMO-TI-10", name: "Tinte Negro 1.0", cents: 11900, stock: 20, category: "Color" },
  { sku: "DEMO-OX-30", name: "Oxidante 30 vol 900 ml", cents: 10900, stock: 15, category: "Color" },
  { sku: "DEMO-DE-500", name: "Decolorante en Polvo 500 g", cents: 25900, stock: 6, category: "Color" },
  { sku: "DEMO-CP-RED", name: "Cepillo Redondo Térmico", cents: 7900, stock: 18, category: "Accesorios" },
  { sku: "DEMO-PE-PRO", name: "Peine de Corte Profesional", cents: 4900, stock: 30, category: "Accesorios" },
  { sku: "DEMO-PI-12", name: "Pinzas para Cabello (set de 12)", cents: 5900, stock: 24, category: "Accesorios" },
  { sku: "DEMO-LIGAS", name: "Ligas sin Metal (paquete)", cents: 3500, stock: 40, category: "Accesorios" },
  { sku: "DEMO-ES-RJ", name: "Esmalte Rojo Clásico 15 ml", cents: 6900, stock: 28, category: "Uñas", bar: true },
  { sku: "DEMO-ES-NU", name: "Esmalte Nude Rosado 15 ml", cents: 6900, stock: 28, category: "Uñas" },
  { sku: "DEMO-TOP", name: "Top Coat Brillo 15 ml", cents: 7500, stock: 20, category: "Uñas" },
  { sku: "DEMO-LIMAS", name: "Limas de Uñas (paquete de 5)", cents: 3900, stock: 35, category: "Uñas" },
  { sku: "DEMO-CR-FA", name: "Crema Facial Hidratante 50 g", cents: 17900, stock: 15, category: "Cuidado de la piel" },
  { sku: "DEMO-LI-FA", name: "Limpiador Facial 150 ml", cents: 14900, stock: 15, category: "Cuidado de la piel" },
  { sku: "DEMO-MK-FA", name: "Mascarilla Facial de Arcilla 100 g", cents: 12900, stock: 12, category: "Cuidado de la piel" },
].map((p, i) => ({ ...p, barcode: p.bar ? barcode(i + 1) : null }));

export const USERS = { admin: "Administrador Demo", vendor: "Vendedor Demo" };

/**
 * Three closed registers, oldest first. `day` is "days before today"; times are local (hour, minute).
 * sale.lines: [sku, quantity]. A `return` refers to a sale by its `id` label; `payment` says when and how it was paid.
 */
export const DAYS = [
  {
    day: 3, opens: [9, 30], closes: [19, 30], initialCents: 50000, countedDiffCents: 0,
    movements: [{ at: [12, 0], type: "OUT", cents: 10000, reason: "Pago a proveedor de limpieza (demostración)" }],
    sales: [
      { id: "A1", at: [10, 5], method: "cash", lines: [["DEMO-SH-500", 2], ["DEMO-AC-500", 1]] },
      { id: "A2", at: [11, 40], method: "card", lines: [["DEMO-TI-71", 1], ["DEMO-OX-30", 1]] },
      { id: "A3", at: [13, 15], method: "cash", lines: [["DEMO-ES-RJ", 2], ["DEMO-LIMAS", 1]] },
      { id: "A4", at: [16, 20], method: "card", lines: [["DEMO-CR-FA", 1]] },
      { id: "A5", at: [17, 5], method: "cash", lines: [["DEMO-GE-250", 1], ["DEMO-CE-60", 1]] },
    ],
  },
  {
    day: 2, opens: [9, 45], closes: [19, 15], initialCents: 40000, countedDiffCents: -500, // a 5.00 shortage, to show a difference
    movements: [{ at: [9, 50], type: "IN", cents: 5000, reason: "Cambio adicional (demostración)" }],
    sales: [
      { id: "B1", at: [10, 30], method: "cash", lines: [["DEMO-SE-100", 1], ["DEMO-OL-30", 1]] },
      { id: "B2", at: [12, 10], method: "card", lines: [["DEMO-TI-50", 2]] },
      { id: "B3", at: [14, 25], method: "cash", lines: [["DEMO-CP-RED", 1], ["DEMO-PE-PRO", 1], ["DEMO-LIGAS", 2]] },
      { id: "B4", at: [17, 40], method: "cash", lines: [["DEMO-ES-NU", 1], ["DEMO-TOP", 1]] },
    ],
    // a return the same day; the refund is paid the NEXT day (payment date differs from return date)
    returns: [{ sale: "B1", at: [18, 0], reason: "Producto no era el esperado (demostración)", lines: [["DEMO-SE-100", 1]], payment: { day: 1, at: [12, 30], method: "cash" } }],
  },
  {
    day: 1, opens: [9, 40], closes: [19, 45], initialCents: 45000, countedDiffCents: 0,
    movements: [],
    sales: [
      { id: "C1", at: [10, 15], method: "cash", lines: [["DEMO-SP-250", 1], ["DEMO-MA-250", 1]] },
      { id: "C2", at: [11, 50], method: "card", lines: [["DEMO-LIGAS", 2], ["DEMO-PI-12", 1]] },
      { id: "C3", at: [15, 5], method: "cash", lines: [["DEMO-TI-10", 1], ["DEMO-OX-30", 1], ["DEMO-LI-FA", 1]] },
    ],
    // a return left PENDING (money not handed back yet): the demonstration pays it live with an administrator PIN
    returns: [{ sale: "C2", at: [16, 30], reason: "Cliente cambió de opinión (demostración)", lines: [["DEMO-LIGAS", 2]], payment: null }],
  },
];

const bySku = new Map(PRODUCTS.map((p) => [p.sku, p]));
export const productBySku = (sku) => {
  const p = bySku.get(sku);
  if (!p) throw new Error("unknown demo SKU " + sku);
  return p;
};
export const lineCents = ([sku, qty]) => productBySku(sku).cents * qty;
export const saleCents = (sale) => sale.lines.reduce((s, l) => s + lineCents(l), 0);

/**
 * What the data MUST add up to (computed here from the definitions, independently of the seeding code): used by the tests to prove
 * that the database ended up exactly as defined.
 */
export function expectedTotals() {
  const stock = new Map(PRODUCTS.map((p) => [p.sku, p.stock]));
  const sales = new Map();
  let salesCount = 0, cashSales = 0, cardSales = 0, returnsCount = 0, pending = 0, paidCash = 0;
  const sessions = [];
  for (const d of DAYS) {
    let cash = d.initialCents;
    for (const s of d.sales) {
      salesCount += 1;
      sales.set(s.id, s);
      const total = saleCents(s);
      if (s.method === "cash") { cashSales += total; cash += total; } else cardSales += total;
      for (const [sku, q] of s.lines) stock.set(sku, stock.get(sku) - q);
    }
    for (const m of d.movements) cash += m.type === "IN" ? m.cents : -m.cents;
    sessions.push({ day: d.day, cash });
  }
  for (const d of DAYS) {
    for (const r of d.returns ?? []) {
      returnsCount += 1;
      const cents = r.lines.reduce((s, l) => s + lineCents(l), 0);
      for (const [sku, q] of r.lines) stock.set(sku, stock.get(sku) + q);
      if (!r.payment) pending += cents;
      else if (r.payment.method === "cash") {
        paidCash += cents;
        sessions.find((x) => x.day === r.payment.day).cash -= cents; // the money leaves the register open when it is paid
      }
    }
  }
  return {
    products: PRODUCTS.length, sales: salesCount, cashSalesCents: cashSales, cardSalesCents: cardSales, returns: returnsCount,
    pendingCents: pending, paidCashCents: paidCash,
    stock: Object.fromEntries(stock),
    sessionBalances: Object.fromEntries(sessions.map((s) => [s.day, s.cash])),
  };
}
