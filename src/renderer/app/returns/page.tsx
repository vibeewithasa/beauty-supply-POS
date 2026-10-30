import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { POSLayout } from "@/components/pos-layout";
import { DocumentDialog } from "@/components/document-dialog";
import { AuthorizationDialog, PaymentFields, money, refundBadge } from "@/components/refund-payment";
import type { RefundMethod } from "@/components/refund-payment";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FileText } from "lucide-react";
import { toast } from "sonner";
import { describeIpcError } from "@/lib/ipc-error";

interface User {
  id: number;
  name: string;
  role: "admin" | "vendor";
}
interface Line {
  id: number;
  productId: number;
  quantity: number;
  unitPrice: string;
  subtotal: string;
  productName: string | null;
  productSku: string | null;
  productStatus: string | null;
  returnedQuantity: number;
  remaining: number;
}
interface SaleLookup {
  sale: { id: number; total: string; paymentMethod: string; createdAt: string; userName: string | null };
  lines: Line[];
}
interface ReturnRow {
  id: number;
  saleId: number;
  totalRefund: string | null;
  refundStatus: "pending" | "paid" | "legacy_unspecified";
  reason: string;
  createdAt: string;
  processedByName: string | null;
  paymentMethod: RefundMethod | null;
  paidAmount: string | null;
  paidAt: string | null;
  externalReference: string | null;
  authorizedByName: string | null;
  paidByName: string | null;
}

const cents = (v: string | number) => Math.round(Number(v) * 100);
const fmt = (c: number) => `$${(c / 100).toFixed(2)}`;
const when = (d: string | Date) => new Date(d).toLocaleString();
const newOperationId = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `op-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`);
const FILTERS: Record<string, string> = { all: "Todas", pending: "Pendientes", cash: "Pagadas en efectivo", card: "Pagadas por tarjeta", legacy: "Legacy" };
const UNCERTAIN =
  "No se pudo confirmar si el reembolso quedó registrado. Si ya entregaste el dinero, VERIFICA el estado en el historial de devoluciones antes de intentar de nuevo. " +
  "Reintentar con esta misma pantalla es seguro: usa la misma operación y no se pagará dos veces.";
// the administrator may simply have mistyped the PIN: the operation stays open for another try
const RETRY_CODES = new Set(["AUTORIZACION_INVALIDA", "AUTORIZACION_BLOQUEADA"]);

export default function ReturnsPage() {
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>(null);
  const [saleIdText, setSaleIdText] = useState("");
  const [lookup, setLookup] = useState<SaleLookup | null>(null);
  const [lookupError, setLookupError] = useState("");
  const [searching, setSearching] = useState(false);
  const [qty, setQty] = useState<Record<number, string>>({});
  const [reason, setReason] = useState("");
  const [method, setMethod] = useState<RefundMethod | "">("");
  const [confirmed, setConfirmed] = useState(false);
  const [reference, setReference] = useState("");
  const [authOpen, setAuthOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [authError, setAuthError] = useState("");
  const [uncertain, setUncertain] = useState("");
  const [resultId, setResultId] = useState<number | null>(null);
  const [pendingNote, setPendingNote] = useState("");
  const [history, setHistory] = useState<ReturnRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");
  const [filter, setFilter] = useState("all");
  const [cash, setCash] = useState<{ open: boolean; current: string } | null>(null);
  const [voucherId, setVoucherId] = useState<number | null>(null);

  // pending return being paid
  const [target, setTarget] = useState<ReturnRow | null>(null);
  const [tMethod, setTMethod] = useState<RefundMethod | "">("");
  const [tConfirmed, setTConfirmed] = useState(false);
  const [tReference, setTReference] = useState("");

  // One key per payment attempt: a double click or a retry after an uncertain error reuses it (the server pays only once).
  const op = useRef<{ sig: string; key: string } | null>(null);
  const operationFor = (sig: string) => {
    if (!op.current || op.current.sig !== sig) op.current = { sig, key: newOperationId() };
    return op.current.key;
  };
  const inflight = useRef(false);

  const loadHistory = useCallback(async () => {
    try {
      setHistoryError("");
      setHistory(await window.api.returns.getAll());
    } catch (error) {
      console.error("Error loading returns:", error);
      setHistoryError(describeIpcError(error, "No se pudo cargar el historial de devoluciones").message);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const loadCash = useCallback(async () => {
    try {
      const s = await window.api.cash.getActiveSession();
      setCash(s ? { open: true, current: s.currentAmount } : { open: false, current: "0" });
    } catch {
      setCash(null); // unknown: the server decides
    }
  }, []);

  useEffect(() => {
    const userStr = sessionStorage.getItem("user");
    if (!userStr) {
      navigate("/");
      return;
    }
    setUser(JSON.parse(userStr));
    loadHistory();
    loadCash();
  }, [navigate, loadHistory, loadCash]);

  const search = async (idText = saleIdText, keepResult = false) => {
    setLookupError("");
    if (!keepResult) {
      setResultId(null);
      setPendingNote("");
    }
    setAuthOpen(false);
    if (!/^\d+$/.test(idText.trim())) {
      setLookup(null);
      setLookupError("Indica el número de venta (solo dígitos)");
      return;
    }
    setSearching(true);
    try {
      const data: SaleLookup = await window.api.returns.getSaleForReturn(Number(idText.trim()));
      setLookup(data);
      setQty({});
      setReason("");
      setMethod("");
      setConfirmed(false);
      setReference("");
      op.current = null;
    } catch (error) {
      setLookup(null);
      setLookupError(describeIpcError(error, "No se pudo buscar la venta").message);
    } finally {
      setSearching(false);
    }
  };

  // per-line validation + the amount preview (the authoritative amount is computed in main from the stored sale lines)
  const parsed = (lookup?.lines ?? []).map((l) => {
    const text = (qty[l.id] ?? "").trim();
    if (text === "") return { line: l, quantity: 0, error: "" };
    if (!/^\d+$/.test(text)) return { line: l, quantity: 0, error: "Entero positivo" };
    const n = Number(text);
    if (n > l.remaining) return { line: l, quantity: n, error: `Máximo ${l.remaining}` };
    return { line: l, quantity: n, error: "" };
  });
  const selected = parsed.filter((p) => p.quantity > 0 && !p.error);
  const hasError = parsed.some((p) => p.error);
  const previewCents = selected.reduce((s, p) => s + cents(p.line.unitPrice) * p.quantity, 0);
  const units = selected.reduce((s, p) => s + p.quantity, 0);

  // Anything the operator changes invalidates a pending attempt (a new key will be generated) and any earlier confirmation.
  const touched = () => {
    setConfirmed(false);
    setUncertain("");
    setAuthError("");
  };

  const cashProblem =
    method === "cash" && cash !== null
      ? !cash.open
        ? "No hay una caja abierta: abre la caja para reembolsar en efectivo, o elige tarjeta."
        : cents(cash.current) < previewCents
          ? `La caja solo tiene ${money(cash.current)}: no alcanza para ${fmt(previewCents)}.`
          : ""
      : "";
  const ready = !!lookup && selected.length > 0 && !hasError && reason.trim() !== "" && method !== "" && confirmed && !cashProblem;

  const payload = () => ({
    saleId: lookup!.sale.id,
    reason,
    items: selected.map((p) => ({ saleItemId: p.line.id, quantity: p.quantity })),
    payment: { method, confirmed: true, ...(method === "card" && reference.trim() ? { reference: reference.trim() } : {}) },
  });

  const openAuthorization = () => {
    if (!ready) {
      toast.error(!method ? "Elige cómo se reembolsó el dinero" : !confirmed ? "Confirma que el dinero ya se entregó" : "Completa la devolución (productos, cantidad y motivo)");
      return;
    }
    setAuthError("");
    setUncertain("");
    setAuthOpen(true);
  };

  const submitRefund = async (pin: string) => {
    if (!lookup || inflight.current) return;
    inflight.current = true;
    setSaving(true);
    setAuthError("");
    setUncertain("");
    const body = payload();
    try {
      const created = await window.api.returns.createWithRefund({ ...body, operationId: operationFor(JSON.stringify(body)) }, pin);
      op.current = null;
      setAuthOpen(false);
      toast.success(created.replayed ? "Esta devolución ya estaba registrada" : "Devolución y reembolso registrados");
      setPendingNote("");
      await search(String(lookup.sale.id), true); // fresh remaining quantities from PostgreSQL
      await Promise.all([loadHistory(), loadCash()]);
      setResultId(created.id);
    } catch (error) {
      const { code, message } = describeIpcError(error, "No se pudo registrar la devolución");
      if (code === null || code === "ERROR_INTERNO") {
        console.error("Error creating refund:", error);
        setUncertain(UNCERTAIN); // outcome unknown: keep the operation key, do not claim anything
      } else if (RETRY_CODES.has(code)) {
        setAuthError(message);
      } else {
        op.current = null;
        setAuthOpen(false);
        toast.error(message);
        await search(String(lookup.sale.id), true);
        await loadCash();
      }
    } finally {
      inflight.current = false;
      setSaving(false);
    }
  };

  // The old behaviour, still available when no administrator is at hand: the return and its stock, with the refund left PENDING.
  const registerPending = async () => {
    if (!lookup || saving || selected.length === 0 || hasError || !reason.trim()) {
      toast.error("Indica al menos una cantidad válida y el motivo");
      return;
    }
    setSaving(true);
    try {
      const created = await window.api.returns.create({ saleId: lookup.sale.id, reason, items: selected.map((p) => ({ saleItemId: p.line.id, quantity: p.quantity })) });
      setResultId(null);
      setPendingNote(`Devolución #${created.id} registrada por ${money(created.totalRefund)}. Estado: PENDIENTE. El dinero NO se ha entregado ni se ha descontado de la caja.`);
      toast.success("Devolución registrada (reembolso pendiente)");
      await search(String(lookup.sale.id), true);
      await loadHistory();
    } catch (error) {
      toast.error(describeIpcError(error, "No se pudo registrar la devolución").message);
      await search(String(lookup.sale.id), true);
    } finally {
      setSaving(false);
    }
  };

  // ------------------------------------------------------------------ paying a return that was registered earlier
  const openTarget = (row: ReturnRow) => {
    setTarget(row);
    setTMethod("");
    setTConfirmed(false);
    setTReference("");
    setAuthError("");
    setUncertain("");
    op.current = null;
    void loadCash();
  };
  const closeTarget = () => {
    setTarget(null);
    setAuthError("");
    setUncertain("");
  };
  const tCashProblem =
    target && tMethod === "cash" && cash !== null
      ? !cash.open
        ? "No hay una caja abierta: abre la caja para reembolsar en efectivo, o elige tarjeta."
        : cents(cash.current) < cents(target.totalRefund ?? 0)
          ? `La caja solo tiene ${money(cash.current)}: no alcanza para ${money(target.totalRefund ?? 0)}.`
          : ""
      : "";

  const submitSettlement = async (pin: string) => {
    if (!target || !tMethod || inflight.current) return;
    inflight.current = true;
    setSaving(true);
    setAuthError("");
    setUncertain("");
    const body = { returnId: target.id, payment: { method: tMethod, confirmed: true, ...(tMethod === "card" && tReference.trim() ? { reference: tReference.trim() } : {}) } };
    try {
      const paid = await window.api.returns.settleRefund({ ...body, operationId: operationFor(JSON.stringify(body)) }, pin);
      op.current = null;
      const id = target.id;
      setTarget(null);
      toast.success(paid.replayed ? "Este pago ya estaba registrado" : "Pago del reembolso registrado");
      setPendingNote("");
      await Promise.all([loadHistory(), loadCash()]);
      setResultId(id);
    } catch (error) {
      const { code, message } = describeIpcError(error, "No se pudo registrar el pago");
      if (code === null || code === "ERROR_INTERNO") {
        console.error("Error settling refund:", error);
        setUncertain(UNCERTAIN);
      } else if (RETRY_CODES.has(code)) {
        setAuthError(message);
      } else {
        op.current = null;
        setTarget(null);
        toast.error(message);
        await Promise.all([loadHistory(), loadCash()]);
      }
    } finally {
      inflight.current = false;
      setSaving(false);
    }
  };

  const verifyInHistory = async () => {
    setAuthOpen(false);
    setTarget(null);
    setAuthError("");
    await Promise.all([loadHistory(), loadCash()]);
    document.getElementById("rt-history")?.scrollIntoView({ block: "start" });
  };

  if (!user) return null;

  const result = resultId !== null ? history.find((r) => r.id === resultId) : undefined;
  const shown = history.filter((r) => filter === "all" || refundBadge(r).key === filter);

  return (
    <POSLayout>
      <div className="p-4 md:p-6 max-w-6xl mx-auto">
        <h1 className="text-2xl md:text-3xl font-bold mb-2">Devoluciones</h1>
        <p className="text-sm text-muted-foreground mb-6">
          Cualquier usuario puede preparar una devolución. Para registrar el reembolso como <strong>pagado</strong> hace falta el PIN de un
          administrador, y solo después de que el dinero ya se haya entregado (efectivo) o devuelto en la terminal (tarjeta).
        </p>

        <Card className="p-4 mb-6">
          <div className="flex gap-3 items-end">
            <div className="flex-1">
              <label htmlFor="rt-sale" className="text-sm font-semibold block mb-1">Número de venta</label>
              <Input
                id="rt-sale"
                inputMode="numeric"
                value={saleIdText}
                onChange={(e) => setSaleIdText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && search()}
                className="h-11"
              />
            </div>
            <Button onClick={() => search()} disabled={searching} className="h-11">
              {searching ? "Buscando..." : "Buscar venta"}
            </Button>
          </div>
          {lookupError && <p role="alert" className="text-sm text-red-600 mt-3">{lookupError}</p>}
        </Card>

        {(result || pendingNote) && (
          <div role="status" data-testid="return-result" className={`text-sm rounded p-3 mb-6 ${result ? "bg-green-50 text-green-900" : "bg-amber-50 text-amber-900"}`}>
            {result ? (
              <div className="space-y-1">
                <p>
                  <strong>Devolución #{result.id}</strong> de la venta #{result.saleId} por <strong>{money(result.totalRefund ?? 0)}</strong>:{" "}
                  <strong>{refundBadge(result).label}</strong>
                  {result.paidAt ? ` el ${when(result.paidAt)}` : ""}.
                </p>
                {result.refundStatus === "paid" && (
                  <p>
                    Autorizó: {result.authorizedByName ?? "—"} · Atendió: {result.paidByName ?? "—"}
                    {result.externalReference ? ` · Referencia: ${result.externalReference}` : ""}
                  </p>
                )}
                <Button variant="outline" size="sm" className="gap-2 mt-1" onClick={() => setVoucherId(result.id)}>
                  <FileText size={16} /> Comprobante
                </Button>
              </div>
            ) : (
              pendingNote
            )}
          </div>
        )}

        {lookup && (
          <Card className="p-4 mb-6">
            <div className="flex flex-wrap justify-between gap-2 mb-4">
              <div>
                <h2 className="text-xl font-bold">Venta #{lookup.sale.id}</h2>
                <p className="text-sm text-muted-foreground">
                  {when(lookup.sale.createdAt)} · {lookup.sale.paymentMethod} · vendedor: {lookup.sale.userName ?? "—"}
                </p>
              </div>
              <div className="text-xl font-bold text-primary">{money(lookup.sale.total)}</div>
            </div>
            <table className="table-pos w-full text-sm">
              <thead>
                <tr>
                  <th>Producto</th>
                  <th>Vendido</th>
                  <th>Ya devuelto</th>
                  <th>Disponible</th>
                  <th>Precio</th>
                  <th>Devolver</th>
                </tr>
              </thead>
              <tbody>
                {parsed.map(({ line, error }) => (
                  <tr key={line.id}>
                    <td>
                      <div className="font-semibold">{line.productName ?? `Producto #${line.productId}`}</div>
                      <div className="text-xs text-muted-foreground font-mono">{line.productSku}</div>
                    </td>
                    <td>{line.quantity}</td>
                    <td>{line.returnedQuantity}</td>
                    <td>{line.remaining}</td>
                    <td>{money(line.unitPrice)}</td>
                    <td>
                      {line.remaining === 0 ? (
                        <span className="text-xs text-muted-foreground">Ya devuelto completo</span>
                      ) : (
                        <>
                          <Input
                            aria-label={`Cantidad a devolver de ${line.productName ?? line.productId}`}
                            inputMode="numeric"
                            className="w-24 h-9"
                            value={qty[line.id] ?? ""}
                            onChange={(e) => {
                              setQty({ ...qty, [line.id]: e.target.value });
                              touched();
                            }}
                          />
                          {error && <div className="text-xs text-red-600 mt-1">{error}</div>}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="mt-4 space-y-4">
              <div>
                <label htmlFor="rt-reason" className="text-sm font-semibold block mb-1">Motivo</label>
                <Input id="rt-reason" value={reason} onChange={(e) => { setReason(e.target.value); touched(); }} />
              </div>
              <p className="text-lg">
                Total a reembolsar: <strong data-testid="refund-preview">{fmt(previewCents)}</strong>{" "}
                <span className="text-xs text-muted-foreground">(calculado con los precios de la venta; el sistema lo vuelve a calcular al registrar)</span>
              </p>
              <PaymentFields
                idPrefix="rf"
                amount={String(previewCents / 100)}
                method={method}
                onMethod={(m) => { setMethod(m); touched(); void loadCash(); /* the register may have changed since the screen was opened */ }}
                confirmed={confirmed}
                onConfirmed={setConfirmed}
                reference={reference}
                onReference={(r) => { setReference(r); setUncertain(""); }}
              />
              {cashProblem && <p role="alert" data-testid="rf-cash-problem" className="text-sm text-red-600">{cashProblem}</p>}
              <Button onClick={openAuthorization} disabled={!ready || saving} className="btn-pos-success w-full h-12 text-base">
                Confirmar devolución y reembolso
              </Button>
              <div className="text-center">
                <button
                  type="button"
                  onClick={registerPending}
                  disabled={saving || selected.length === 0 || hasError || !reason.trim()}
                  className="text-sm underline text-muted-foreground disabled:opacity-50 disabled:no-underline"
                >
                  Registrar la devolución sin reembolso (queda PENDIENTE de pago)
                </button>
              </div>
            </div>
          </Card>
        )}

        <Card className="p-4" id="rt-history">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h2 className="font-semibold">Historial de devoluciones</h2>
            <div className="flex items-center gap-2">
              <label htmlFor="rt-filter" className="text-sm text-muted-foreground">Estado</label>
              <select id="rt-filter" value={filter} onChange={(e) => setFilter(e.target.value)} className="h-9 rounded-md border bg-background px-2 text-sm">
                {Object.entries(FILTERS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
          </div>
          {historyLoading ? (
            <p className="text-sm text-muted-foreground">Cargando...</p>
          ) : historyError ? (
            <p className="text-sm text-red-600">{historyError}</p>
          ) : history.length === 0 ? (
            <p className="text-sm text-muted-foreground">Todavía no hay devoluciones registradas.</p>
          ) : shown.length === 0 ? (
            <p className="text-sm text-muted-foreground">No hay devoluciones con ese estado.</p>
          ) : (
            <div className="max-h-96 overflow-auto">
              <table className="table-pos w-full text-sm" aria-label="Devoluciones">
                <thead>
                  <tr><th>#</th><th>Venta</th><th>Fecha devolución</th><th>Monto</th><th>Estado</th><th>Pago</th><th>Autorizó / Atendió</th><th>Motivo</th><th>Registró</th><th></th></tr>
                </thead>
                <tbody>
                  {shown.map((r) => {
                    const b = refundBadge(r);
                    return (
                      <tr key={r.id} data-testid={`return-row-${r.id}`}>
                        <td>{r.id}</td>
                        <td>#{r.saleId}</td>
                        <td>{when(r.createdAt)}</td>
                        <td>{money(r.totalRefund ?? 0)}</td>
                        <td className={b.className} data-testid={`return-state-${r.id}`}>{b.label}</td>
                        <td>
                          {r.paidAt ? (
                            <>
                              {when(r.paidAt)}
                              {r.externalReference && <div className="text-xs text-muted-foreground">Ref. {r.externalReference}</div>}
                            </>
                          ) : "—"}
                        </td>
                        <td>{r.refundStatus === "paid" ? `${r.authorizedByName ?? "—"} / ${r.paidByName ?? "—"}` : "—"}</td>
                        <td>{r.reason}</td>
                        <td>{r.processedByName ?? "—"}</td>
                        <td className="whitespace-nowrap">
                          {r.refundStatus === "pending" && (
                            <Button size="sm" className="btn-pos-success mr-2" onClick={() => openTarget(r)} data-testid={`pay-pending-${r.id}`}>
                              Registrar pago pendiente
                            </Button>
                          )}
                          <Button size="sm" variant="outline" className="h-10 w-10 p-0" aria-label={`Comprobante de la devolución ${r.id}`} onClick={() => setVoucherId(r.id)}>
                            <FileText size={16} />
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <AuthorizationDialog
        open={authOpen}
        title="Autorización de administrador"
        description="Un administrador debe autorizar el reembolso con su PIN."
        submitLabel="Autorizar y registrar"
        busy={saving}
        error={authError}
        warning={uncertain}
        onSubmit={submitRefund}
        onCancel={() => { setAuthOpen(false); setAuthError(""); setUncertain(""); }}
        onVerify={verifyInHistory}
      >
        <div className="rounded border bg-muted/40 p-3 text-sm space-y-1" data-testid="rf-summary">
          <p>Venta #{lookup?.sale.id} · {units} unidad(es) vuelven al inventario</p>
          <p>
            Reembolso de <strong>{fmt(previewCents)}</strong> —{" "}
            <strong>{method === "cash" ? "en efectivo desde la caja" : "con tarjeta (ya realizado en la terminal)"}</strong>
          </p>
          {method === "card" && reference.trim() && <p>Referencia: {reference.trim()}</p>}
          <p className="text-xs text-muted-foreground">Motivo: {reason}</p>
        </div>
      </AuthorizationDialog>

      <AuthorizationDialog
        open={target !== null}
        title={target ? `Registrar pago de la devolución #${target.id}` : "Registrar pago"}
        description="Esta devolución ya está registrada: solo falta registrar que el dinero se entregó. No vuelve a mover inventario."
        submitLabel="Autorizar y registrar pago"
        busy={saving}
        error={authError}
        warning={uncertain}
        canSubmit={!!target && tMethod !== "" && tConfirmed && !tCashProblem}
        onSubmit={submitSettlement}
        onCancel={closeTarget}
        onVerify={verifyInHistory}
      >
        {target && (
          <div className="space-y-3">
            <div className="rounded border bg-muted/40 p-3 text-sm" data-testid="rf-pending-summary">
              Devolución #{target.id} de la venta #{target.saleId} · <strong>{money(target.totalRefund ?? 0)}</strong>
              <div className="text-xs text-muted-foreground">Motivo: {target.reason}</div>
            </div>
            <PaymentFields
              idPrefix="rp"
              amount={target.totalRefund ?? "0"}
              method={tMethod}
              onMethod={(m) => { setTMethod(m); setTConfirmed(false); setUncertain(""); void loadCash(); }}
              confirmed={tConfirmed}
              onConfirmed={setTConfirmed}
              reference={tReference}
              onReference={(r) => { setTReference(r); setUncertain(""); }}
            />
            {tCashProblem && <p role="alert" data-testid="rp-cash-problem" className="text-sm text-red-600">{tCashProblem}</p>}
          </div>
        )}
      </AuthorizationDialog>

      <DocumentDialog
        key={voucherId ?? "none"}
        open={voucherId !== null}
        title={`Comprobante de devolución #${voucherId}`}
        description="Documento interno, no fiscal. Imprimir no modifica la devolución."
        iframeTitle="Vista previa del comprobante de devolución"
        sentLabel="Comprobante enviado a imprimir"
        load={() => window.api.returns.previewVoucher(voucherId as number)}
        print={() => window.api.returns.printVoucher(voucherId as number)}
        onClose={() => setVoucherId(null)}
      />
    </POSLayout>
  );
}
