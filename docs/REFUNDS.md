# Returns and refunds with an administrator PIN

Policy approved by the owner of Estética Leal, as implemented in Sprint 05 (branch `feat/pos-authorized-refunds`).
Everything here is covered by `npm run test:refunds`, `test:refundauth`, `test:refundui`, the unit tests and the migration tests.

## The policy, in one screen

1. Any signed-in user (seller or administrator) can start and prepare a return.
2. The money can be handed back in **cash from the register** or on the **card** terminal. The method may differ from how the
   sale was paid.
3. Completing the return **and recording the refund as paid always needs the PIN of an active administrator**.
4. The administrator authorizes without closing or replacing the operator's session.
5. The return and its payment are recorded together, in one transaction (or nothing is).
6. A refund cannot be paid twice.
7. **Card means a refund made outside the system on the card terminal.** The POS performs no bank operation.
8. A refund is **never** marked as paid unless the operator explicitly confirmed that the money was already handed back
   (cash delivered / refund done on the terminal).
9. Old pending returns can be paid with the same process; old `legacy_unspecified` returns stay legacy.

## States the owner sees

| Label | Meaning |
|---|---|
| PENDIENTE | The return is registered (stock is back) but the customer was **not** paid yet. Money owed. |
| PAGADO EN EFECTIVO | Paid in cash; the cash left the register that was open at that moment. |
| PAGADO POR TARJETA | Refunded on the terminal. Informational for the register: it never reduces the cash. |
| LEGACY | Registered before refund control existed. Whether it was paid is unknown; it is never shown or treated as paid. |

## Channels (all `authenticated`; the PIN is the authorization)

| Channel | What it does |
|---|---|
| `returns:create` | Unchanged: registers a return **without** a refund (stays PENDIENTE). Still useful when no administrator is at hand. |
| `returns:createWithRefund(data, adminPin)` | New return + settlement in one transaction. `data = { saleId, reason, items:[{saleItemId, quantity}], payment:{ method:'cash'\|'card', confirmed:true, reference? }, operationId }` |
| `returns:settleRefund(data, adminPin)` | Pays a return that already exists and is pending. `data = { returnId, payment, operationId }`. Puts no stock back and creates no lines. |
| `returns:previewVoucher(id)` / `returns:printVoucher(id)` | Internal voucher of a return (not a fiscal document, no CFDI). Built in main from PostgreSQL; printing writes nothing. |

The renderer never sends an amount, an administrator id, a register, a status or a date: the amount is the sum of
`return_items.refund_amount` (computed from the persisted `sale_items`: unit price x quantity in integer cents), the register is the
single open one, the operator comes from the session and the administrator from the verified PIN. Extra fields are rejected.

## Administrator authorization (`src/backend/admin-authorization.ts`)

- The PIN travels **with the operation it authorizes** and is verified in the main process against the active users (scrypt, and the
  legacy SHA-256 hashes, which are upgraded after a successful authorization). It is **not** `auth:login`: the operator stays signed in.
- Nothing reusable exists afterwards: no token, no cache, no remembered administrator. There is nothing to expire, steal or replay, and the
  authorization is valid for exactly the one operation that carried the PIN.
- Only an active administrator can authorize. A wrong PIN, a seller's PIN, an inactive administrator's PIN, an unknown PIN and a malformed
  one all fail with the same `[AUTORIZACION_INVALIDA]` message: nothing to enumerate.
- Attempts have their **own installation-wide budget** (same limits as the login: 5 failures, 30 s lock, doubling up to 15 min), one for
  the whole PIN space, not per window or user. Attempts are serialized through a gate, so a burst of parallel requests cannot exceed
  the budget. A correct PIN is refused while locked (`[AUTORIZACION_BLOQUEADA]`). It is deliberately **not shared with the login counter**:
  a successful login resets that one, and a signed-in seller could otherwise alternate guesses at the administrator PIN with logins of
  their own PIN. Only a successful administrator authorization (or a quiet period) resets this counter.
- The PIN is never stored, logged, echoed or returned. The dialog clears it the moment it is submitted. The audit rows hold ids only.
- Who is recorded: `refund_settlements.authorized_by` (administrator) and `processed_by` (the signed-in user who attended; the
  same person when an administrator starts and authorizes). `returns.processed_by` keeps who registered the return.

## Data model (migration 0009, additive)

`refund_settlements`: `return_id` (**unique**: one payment per return), `payment_method` (`cash`/`card`), `amount`, `authorized_by`,
`processed_by`, `paid_at`, `cash_session_id`, `cash_movement_id`, `external_reference`, `operation_id` (unique when present).
CHECK constraints: amount >= 0; a cash settlement must have a register session and a movement and no reference; a card settlement can
never own a movement. A cash movement can back at most one settlement. The migration creates the table empty: old returns are not
touched and nothing is marked as paid. `returns.refund_status = 'paid'` is only ever set together with a settlement row.

- **Cash:** needs the open register (row lock); refuses when the balance is not enough (never negative); writes a `cash_movements` OUT
  linked through `cash_movement_id`, reduces `cash_sessions.current_amount` once; the movement shows in the register history.
- **Card:** no cash movement and no balance change. If a register is open, the settlement is attached to it so the closing report can list
  card refunds (informational); otherwise `cash_session_id` stays empty.
- Reports use the settlement, never the movement text. A refund paid in cash is **not** a manual withdrawal: summaries exclude movements
  that back a settlement from "Retiros".

## Concurrency and idempotency

Lock order, shared by every flow: operation advisory lock -> cash session -> sale -> sale_items (ascending id) -> products (ascending id)
-> return row. Sales take session -> products; cash movements and the closing take the session; plain returns take sale -> items ->
products; refunds take them in the order above. No flow takes these in another order, so they cannot deadlock (stress-tested: refunds, sales,
withdrawals and card refunds in parallel; closing racing refunds).

The client generates one `operationId` per attempt and keeps it across retries of the same content. A repeated attempt (double click,
retry after an uncertain error, parallel duplicates) returns the stored result (`replayed: true`) without asking for a PIN and without moving
anything; the same key with different content (other lines, method, reason, reference or operator) is rejected (`OPERACION_DUPLICADA`).
Competing payments of one return with different keys: one wins, the others get `[REEMBOLSO_YA_PAGADO]`.

If the outcome is unknown (an unexpected error after the operator handed over the money) the screen says so, tells the operator to **verify
the history before paying again**, and offers to retry with the same operation key, which is safe.

## Reports

- Dashboard: *Reembolsos pendientes de pago* (owed, all dates), *pagados en efectivo (hoy)*, *pagados por tarjeta (hoy)* by **payment date**.
- Reports: returns by state (by return date) and refunds paid by method (by **payment date**), plus what is still owed now.
- Register summary (screen, CSV, printable): cash refunds reduce the expected cash once; card refunds are informational; pending refunds are
  shown apart as money still owed. Expected cash = initial + cash sales + manual income - withdrawals - cash refunds.
- A return and its payment can fall on different days; each report says which date it uses. Each refund is counted once.

## Decisions taken here and open items

- **Legacy returns cannot be paid from the POS**: whether the customer was already paid is unknown, so the system refuses (`REEMBOLSO_LEGACY`)
  instead of risking a second payment. Owner decision pending: a deliberate, audited way to resolve them, if wanted.
- **Cash is taken from the register open at the moment of payment**, which may be a different session from the one of the sale.
- `returns:getAll`, `returns:getSaleForReturn` and `returns:create` are still open to every signed-in user (unchanged, owner decision pending).
- Sellers share one administrator PIN budget with every other seller on the installation (a lock affects everyone).
- The login counter itself can still be reset by a successful login (pre-existing): a signed-in user could alternate guesses at an administrator's PIN
  *through the login screen*. Longer PINs (6-8 digits are enforced for new ones) and the lock make it slow, not impossible.
- The unit of "physical delivery" is outside PostgreSQL: the system records what the operator confirms.
