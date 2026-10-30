# UX audit — Beauty Supply POS (Estética Leal)

Branch `feat/pos-ux-sales-receipts`, base `4ebe7ba`. Every statement below comes from reading the code of each screen and
from the automated visual runs (Playwright driving the real Electron window, screenshots kept locally in
`e2e-artifacts/`, which Git ignores). Things that were **not** measured are listed explicitly at the end of the method.

## Method

* Read all 12 screens and the shared pieces (navigation, dialogs, toasts, tables).
* `npm run test:ux`: every screen at **1024x768, 1366x768 and 1920x1080**: no horizontal page overflow, no clipped
  tables, an `h1` per screen, labelled form controls, navigation height, critical buttons inside the viewport, dialogs
  inside the viewport, receipt preview legible at 80 mm and 58 mm, vendor navigation, touch-target report.
* Functional suites for the changed flows: `test:cart`, `test:history`, `test:receipts`.
* **Not measured:** colour contrast ratios (reviewed by eye only), screen-reader behaviour, a physical barcode scanner, a
  physical touch screen, a physical or thermal printer (print output is checked as a PDF of the real print document).

## Screen inventory

| Screen (route) | Purpose | Who | What really works | Dead / duplicated | Main risks found | Backend | Tests |
|---|---|---|---|---|---|---|---|
| Login (`/`) | PIN sign-in | everyone | keypad **and now the physical keyboard** (digits, Backspace, Esc, Enter), lock message, 4–8 digits | — | none open | `auth:*` | pin, security, ux |
| Dashboard (`/dashboard`) | day/week figures | admin | sales, cash, refunds, stock, users | "Reembolsos pagados" can only ever show $0.00: nothing settles refunds (policy pending). Cards link nowhere | the paid-refund card is misleading until a settlement exists | `dashboard:getStats` | ui, ux |
| Vender (`/sales`) | checkout | both | search, scanner (keyboard wedge), cart, confirmations, payment dialog with **change aid**, completed-sale modal, receipt view/print | the old hidden barcode input never worked (removed) | see "Implemented" | `sales:create`, `products:*`, `cash:*`, `sales:getDetail`, `receipts:*` | cart, ui, integration, receipts |
| Caja (`/cash`) | open/close register, movements | both | open, movement, close with expected total, per-session cash/card totals | — | no summary once the register is closed (P1) | `cash:*` | ui, cart |
| Historial (`/history`) | find a past sale, reprint | both (vendor: own sales only) | folio search, dates, method, server pagination, detail with returns, preview, reprint | — | visibility rule for vendors is a product decision (below) | `sales:list`, `sales:getDetail` | history, receipts |
| Productos (`/inventory`) | catalogue | admin | list/search, create, edit, price change with history, logical delete | row actions were 32 px high (now 40 px) | — | `products:*`, `priceChanges:*` | screens |
| Recepción (`/receive`) | stock IN/OUT/ADJUST | admin | movements with reason and history | no supplier purchases (by design) | — | `inventory:*` | screens |
| Ver Stock (`/stock`) | read-only stock | both | search (now also barcode), **low-stock filter**, error state | overlaps with Productos for admins (kept: vendors need a read-only view) | — | `products:getAll` | ux |
| Devoluciones (`/returns`) | returns | both | lookup, partial return, pending refund, history | — | refunds can never be marked paid (policy pending) | `returns:*` | screens, returns |
| Reportes (`/reports`) | sales report | admin | range, methods, products, returns by status, CSV | — | CSV export is unit-tested only | `reports:getSummary` | screens |
| Usuarios (`/users`) | accounts | admin | create, edit, deactivate | used the browser's native `confirm()` (now an in-app dialog); search box had no accessible name (fixed) | — | `users:*` | pin, security, ux |
| Configuración (`/settings`) | business data for the ticket | admin | name, address, phone, WhatsApp, tax data, footer, return policy, logo, paper 80/58, printer | — | stores no secrets; logo limited to 200 KB PNG/JPEG | `settings:*`, `receipts:listPrinters` | receipts, ux |

## Findings

### Implemented in this sprint (with evidence)

| # | Change | Evidence |
|---|---|---|
| 1 | No "added to cart" toast; notices moved to the bottom-left so they never cover Pay or the navigation | CART-01 |
| 2 | Confirmation before clearing the cart and before removing a line (also 1 → 0 with "−" or by typing 0); 5 → 4 stays immediate | CART-02/03/04 |
| 3 | Checkout guarded against double click/Enter; **idempotent checkout** (`operationId`, additive migration 0007): retry or concurrent identical requests return the same sale | CART-05, CART-09/10/11 |
| 4 | Completed-sale modal cannot be dismissed by clicking outside or Esc, shows folio/total/date read back from PostgreSQL, has Ver recibo / Imprimir / Nueva venta; printing problems never change the sale | CART-06/07, REC-10 |
| 5 | Rejected sales keep the cart and re-sync stock/price | CART-08 |
| 6 | Search: mouse, ↑/↓/Enter, exact-code Enter for keyboard-wedge scanners, ambiguous term adds nothing, focus stays in the search box (a real bug: the input component does not forward refs, so focus handling had silently never worked) | CART-12 |
| 7 | Sales history with real server-side pagination (no 100-row ceiling), folio/date/method filters, detail, returns, restart persistence | HIS-00…10 |
| 8 | Sales keep the product **as sold** (name/SKU snapshot); old sales fall back to the catalogue name and are labelled as such | HIS-05, MIG-01/03 |
| 9 | Estética Leal ticket (80/58 mm, B/W, escaped), commercial settings, preview, print, reprint | REC-* , UX-05 |
| 10 | Navigation grouped (Operación / Inventario / Gestión), one row at 1024 px, 40 px targets | UX-01 |
| 11 | Dialogs scroll inside the window instead of being cut off at 1024x768 (the payment dialog overflowed by 5 px) | UX-02/04 |
| 12 | Cash **change aid** in the payment dialog (optional, not stored) | UX-03 |
| 13 | Login by physical keyboard | UX-00 |
| 14 | In-app confirmation to deactivate a user instead of the native `confirm()` | pin suite UI-USERS-01 |
| 15 | Stock screen: barcode search, low-stock filter, error/empty states, scrollable table | UX-01 |
| 16 | Consistent page padding and `h1` size; row-action buttons 40 px; unlabelled inputs fixed | UX-01, UX-07 |
| 17 | A long unbroken seller name no longer runs past the 58 mm paper | UX-05 |
| 18 | Removed `AppRouter.tsx`: a 145-line duplicate of the routes in `App.tsx` that nothing imports | `grep` shows no importer; typecheck unchanged |

### Priorities not implemented

* **P0 (before a real store, outside this sprint's scope):** a way to *pay* a pending refund and record it in the cash
  register (the owner's refund policy is still provisional); automated backups; code signing and a dependency upgrade
  (see `docs/STATUS.md`).
* **P1:** closing-day summary after the register closes (sales by method, refunds, difference); recording the cash
  received/change on the sale and printing it; export of the sales history; showing the ticket number format
  agreed with the owner; per-line discounts are not supported at all.
* **P2:** drill-down links from dashboard cards; merging "Ver Stock" into "Productos" for admins; barcode label
  printing; keyboard shortcuts for the sales screen (F-keys); a read-only "stock bajo" badge in the sales search.
* **NO NECESARIO / DUPLICADO:** hidden barcode input in the sales screen (removed); `AppRouter.tsx` (removed); the
  unused backend channels `sales:getAll`, `sales:getById`, `reports:getSalesByDateRange`, `reports:getDeletedProducts`
  have no screen any more (kept: they are covered by tests and policy, removing them is a separate decision);
  `drizzle/migrations/0001_initial.sql` (legacy file outside the journal) and the twin `hooks/use-mobile.ts(x)` files.

## Decisions the owner needs to make

1. **Refunds:** how a pending refund is paid (cash from the register? card reversal?) and who may do it.
2. **Who sees the history:** today a vendor sees and reprints only **their own** sales, an administrator sees all. Is
   that right, or should every vendor see every sale (as the old `sales:getAll` allowed)?
3. **Ticket content:** confirm address, phone, WhatsApp, return policy text and whether fiscal data should ever appear. The
   ticket says "comprobante comercial, no fiscal" and nothing about CFDI.
4. **Change/cash received:** should it be stored and printed, or stay a screen aid?
5. **Printing:** system dialog every time (default) or silent printing to a fixed printer; default paper size.
6. Whether vendors should be allowed to reprint old sales or only the ones from the current shift.

## Evidence

Final run of `npm run test:all` on this branch (with `E2E_PORT` set because a developer session held 5173):
unit **118/118**, Electron suites **260 PASS, 0 FAIL, 1 SKIP** (12 suites, 235 tests + 36 infrastructure checks), migrations
**24/24**. Packaged build: `npm run test:packaged` **12/12**. Suites referenced above: `test:cart` (14 tests),
`test:history` (11), `test:receipts` (13), `test:ux` (15), `test:screens`, `test:security`, `test:migrations`, `test:packaged`.
The only SKIP is the placeholder entry in the dev-server suite that points to the packaged runner.
No physical printer, scanner or touch screen was used.

## Proposal for the next sprint

1. Refund settlement with cash-register movement (after decision 1).
2. Closing-day summary and its printable report.
3. Backups and restore procedure; dependency upgrade (Electron, `drizzle-orm`, `react-router`) with the suites as the net.
4. Stored cash-received/change if the owner wants it on the ticket.

## Sprint 06: pilot walkthrough (1024x768)

The pilot suite (`npm run test:pilot`) walked the store day through the real window and measured the main screens at 1024x768:

- Pagar stays fully visible and uncovered with a 14-line cart (44 px or more high); clearing the cart asks first.
- Every button and link of the visited screens is at least 36 px; the login keypad is 56x48 px or more. (Found and fixed: the voucher icon button in the returns history was 32 px wide.)
- Found and fixed: the seven cash stat cards at 1024 px made large amounts touch the card edge; the grid is now 2 / 4 / 7 columns (small / medium / extra large).
- Observed, not changed: the sales screen reads the catalogue when it opens, so a product created behind its back (another terminal, SQL) appears after reopening the screen; creating it from Productos then going to Vender works because the screen remounts.
- Not covered: a real touch screen, a physical thermal printer and a barcode reader (see docs/PILOT_CHECKLIST.md).
