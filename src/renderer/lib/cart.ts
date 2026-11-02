// Pure cart rules shared by the cart state and the sales screen. No React, no IPC.

export interface CartItem {
  productId: number;
  sku: string;
  name: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
}

export interface CatalogProduct {
  id: number;
  price: string | number;
  stock: number;
}

export type CartIssue =
  | { kind: "price"; productId: number; name: string; oldPrice: number; newPrice: number }
  | { kind: "stock"; productId: number; name: string; quantity: number; available: number }
  | { kind: "unavailable"; productId: number; name: string };

const cents = (n: number) => Math.round(n * 100);

/**
 * Differences between what the cart remembers and the catalog read now. The cart keeps the price it showed when the
 * product was added; coming back from another module the catalog may have moved on. Nothing here changes the cart.
 */
export function findCartIssues(items: CartItem[], catalog: CatalogProduct[]): CartIssue[] {
  const byId = new Map(catalog.map((p) => [p.id, p]));
  const issues: CartIssue[] = [];
  for (const item of items) {
    const p = byId.get(item.productId);
    if (!p || p.stock <= 0) {
      issues.push({ kind: "unavailable", productId: item.productId, name: item.name });
      continue;
    }
    const price = Number(p.price);
    if (cents(price) !== cents(item.unitPrice)) issues.push({ kind: "price", productId: item.productId, name: item.name, oldPrice: item.unitPrice, newPrice: price });
    if (item.quantity > p.stock) issues.push({ kind: "stock", productId: item.productId, name: item.name, quantity: item.quantity, available: p.stock });
  }
  return issues;
}

/** The cart after the operator accepted the differences: current prices, quantities capped to the stock, unavailable lines out. */
export function applyCartIssues(items: CartItem[], catalog: CatalogProduct[]): CartItem[] {
  const byId = new Map(catalog.map((p) => [p.id, p]));
  return items.flatMap((item) => {
    const p = byId.get(item.productId);
    if (!p || p.stock <= 0) return [];
    const quantity = Math.min(item.quantity, p.stock);
    const unitPrice = Number(p.price);
    return [{ ...item, quantity, unitPrice, subtotal: Math.round(quantity * unitPrice * 100) / 100 }];
  });
}

export function describeCartIssue(issue: CartIssue): string {
  const money = (v: number) => `$${v.toFixed(2)}`;
  switch (issue.kind) {
    case "price":
      return `${issue.name}: el precio cambió de ${money(issue.oldPrice)} a ${money(issue.newPrice)}.`;
    case "stock":
      return `${issue.name}: hay ${issue.available} ${issue.available === 1 ? "unidad disponible" : "unidades disponibles"} y el carrito tiene ${issue.quantity}.`;
    case "unavailable":
      return `${issue.name}: ya no está disponible y se quitará del carrito.`;
  }
}

/** Same signature = same checkout attempt: it may reuse its operation id; any other cart or method is a new attempt. */
export function checkoutSignature(items: CartItem[], method: string, sessionId: number): string {
  return JSON.stringify([method, sessionId, items.map((i) => [i.productId, i.quantity, i.unitPrice, i.subtotal])]);
}
