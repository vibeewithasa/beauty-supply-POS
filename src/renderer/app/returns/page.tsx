import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { POSLayout } from "@/components/pos-layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

const STATUS_LABEL: Record<string, string> = {
  pending: "PENDIENTE DE REEMBOLSO",
  paid: "Reembolso pagado",
  legacy_unspecified: "Anterior al control de reembolsos (sin especificar)",
};
const STATUS_CLASS: Record<string, string> = {
  pending: "text-amber-700 font-semibold",
  paid: "text-green-700 font-semibold",
  legacy_unspecified: "text-muted-foreground",
};
const cents = (v: string | number) => Math.round(Number(v) * 100);
const fmt = (c: number) => `$${(c / 100).toFixed(2)}`;
const money = (v: string | number) => fmt(cents(v));
const when = (d: string | Date) => new Date(d).toLocaleString();

export default function ReturnsPage() {
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>(null);
  const [saleIdText, setSaleIdText] = useState("");
  const [lookup, setLookup] = useState<SaleLookup | null>(null);
  const [lookupError, setLookupError] = useState("");
  const [searching, setSearching] = useState(false);
  const [qty, setQty] = useState<Record<number, string>>({});
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<string>("");
  const [history, setHistory] = useState<any[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");

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

  useEffect(() => {
    const userStr = sessionStorage.getItem("user");
    if (!userStr) {
      navigate("/");
      return;
    }
    setUser(JSON.parse(userStr));
    loadHistory();
  }, [navigate, loadHistory]);

  const search = async (idText = saleIdText, keepResult = false) => {
    setLookupError("");
    if (!keepResult) setDone("");
    setConfirming(false);
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
    } catch (error) {
      setLookup(null);
      setLookupError(describeIpcError(error, "No se pudo buscar la venta").message);
    } finally {
      setSearching(false);
    }
  };

  // per-line validation + the amount preview (the authoritative amount is computed in main under locks)
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

  const review = () => {
    if (selected.length === 0 || hasError) {
      toast.error("Indica al menos una cantidad válida a devolver");
      return;
    }
    if (!reason.trim()) {
      toast.error("Indica el motivo de la devolución");
      return;
    }
    setConfirming(true);
  };

  const confirm = async () => {
    if (!lookup) return;
    setSaving(true);
    try {
      const created = await window.api.returns.create({
        saleId: lookup.sale.id,
        reason,
        items: selected.map((p) => ({ saleItemId: p.line.id, quantity: p.quantity })),
      });
      setDone(
        `Devolución #${created.id} registrada por ${money(created.totalRefund)}. Estado: ${STATUS_LABEL[created.refundStatus] ?? created.refundStatus}. ` +
          "El dinero NO se ha entregado ni se ha descontado de la caja; el reembolso queda pendiente."
      );
      toast.success("Devolución registrada (reembolso pendiente)");
      setConfirming(false);
      await search(String(lookup.sale.id), true); // refresh remaining quantities from PostgreSQL
      await loadHistory();
    } catch (error) {
      console.error("Error creating return:", error);
      toast.error(describeIpcError(error, "No se pudo registrar la devolución").message);
      setConfirming(false);
      await search(String(lookup.sale.id), true); // quantities may have changed
    } finally {
      setSaving(false);
    }
  };

  if (!user) return null;

  return (
    <POSLayout>
      <div className="p-6 max-w-5xl mx-auto">
        <h1 className="text-3xl font-bold mb-2">Devoluciones</h1>
        <p className="text-sm text-muted-foreground mb-6">
          Una devolución registrada devuelve el stock y queda como <strong>PENDIENTE DE REEMBOLSO</strong>. Este sistema aún no entrega
          ni descuenta dinero de la caja.
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

        {done && (
          <p role="status" data-testid="return-result" className="text-sm bg-amber-50 text-amber-900 rounded p-3 mb-6">
            {done}
          </p>
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
                            onChange={(e) => { setQty({ ...qty, [line.id]: e.target.value }); setConfirming(false); }}
                          />
                          {error && <div className="text-xs text-red-600 mt-1">{error}</div>}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="mt-4 space-y-3">
              <div>
                <label htmlFor="rt-reason" className="text-sm font-semibold block mb-1">Motivo</label>
                <Input id="rt-reason" value={reason} onChange={(e) => { setReason(e.target.value); setConfirming(false); }} />
              </div>
              <p className="text-lg">
                Reembolso a registrar: <strong data-testid="refund-preview">{fmt(previewCents)}</strong>{" "}
                <span className="text-xs text-muted-foreground">(estimado; el monto definitivo lo calcula el sistema)</span>
              </p>
              {!confirming ? (
                <Button onClick={review} className="btn-pos-primary w-full h-12">Revisar devolución</Button>
              ) : (
                <div className="rounded border border-amber-400 bg-amber-50 p-4 space-y-3">
                  <p className="text-sm">
                    Se devolverán {selected.reduce((s, p) => s + p.quantity, 0)} unidad(es) al inventario y se registrará un reembolso de{" "}
                    <strong>{fmt(previewCents)}</strong> como <strong>PENDIENTE DE REEMBOLSO</strong>. No se entrega dinero ni se toca la caja.
                  </p>
                  <div className="flex gap-3">
                    <Button variant="outline" className="flex-1" onClick={() => setConfirming(false)}>Cancelar</Button>
                    <Button className="btn-pos-success flex-1" disabled={saving} onClick={confirm}>
                      {saving ? "Registrando..." : "Confirmar devolución"}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </Card>
        )}

        <Card className="p-4">
          <h2 className="font-semibold mb-3">Historial de devoluciones</h2>
          {historyLoading ? (
            <p className="text-sm text-muted-foreground">Cargando...</p>
          ) : historyError ? (
            <p className="text-sm text-red-600">{historyError}</p>
          ) : history.length === 0 ? (
            <p className="text-sm text-muted-foreground">Todavía no hay devoluciones registradas.</p>
          ) : (
            <div className="max-h-80 overflow-y-auto">
              <table className="table-pos w-full text-sm">
                <thead>
                  <tr><th>#</th><th>Venta</th><th>Fecha</th><th>Monto</th><th>Estado del reembolso</th><th>Motivo</th><th>Procesó</th></tr>
                </thead>
                <tbody>
                  {history.map((r) => (
                    <tr key={r.id}>
                      <td>{r.id}</td>
                      <td>#{r.saleId}</td>
                      <td>{when(r.createdAt)}</td>
                      <td>{money(r.totalRefund)}</td>
                      <td className={STATUS_CLASS[r.refundStatus] ?? ""}>{STATUS_LABEL[r.refundStatus] ?? r.refundStatus}</td>
                      <td>{r.reason}</td>
                      <td>{r.processedByName ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </POSLayout>
  );
}
