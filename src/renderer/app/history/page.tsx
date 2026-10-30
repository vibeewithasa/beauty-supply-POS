import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { POSLayout } from "@/components/pos-layout";
import { ReceiptDialog } from "@/components/receipt-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ChevronLeft, ChevronRight, FileText, Printer, Search } from "lucide-react";
import { describeIpcError } from "@/lib/ipc-error";

interface User {
  id: number;
  name: string;
  role: "admin" | "vendor";
}
interface Row {
  id: number;
  total: string;
  paymentMethod: "cash" | "card";
  createdAt: Date | string;
  sellerName: string | null;
  itemCount: number;
  returnCount: number;
}
interface Filters {
  q: string;
  from: string;
  to: string;
  method: "" | "cash" | "card";
}

const PAGE_SIZE = 20;
const METHOD_LABEL = { cash: "Efectivo", card: "Tarjeta" } as const;
const REFUND_LABEL: Record<string, string> = {
  pending: "PENDIENTE DE REEMBOLSO",
  paid: "Reembolso pagado",
  legacy_unspecified: "Anterior al control de reembolsos",
};
const money = (v: string | number) => `$${Number(v).toFixed(2)}`;
const when = (d: Date | string) => new Date(d).toLocaleString();
const EMPTY: Filters = { q: "", from: "", to: "", method: "" };

export default function HistoryPage() {
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>(null);
  const [form, setForm] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ rows: Row[]; total: number; pageCount: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [detailId, setDetailId] = useState<number | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [detailError, setDetailError] = useState("");
  const [receipt, setReceipt] = useState<{ id: number; copy: boolean } | null>(null);

  const load = useCallback(async (f: Filters, p: number) => {
    setLoading(true);
    setError("");
    try {
      const r = await window.api.sales.list({
        page: p,
        pageSize: PAGE_SIZE,
        q: f.q || undefined,
        from: f.from || undefined,
        to: f.to || undefined,
        method: f.method || undefined,
      });
      setData(r);
    } catch (e) {
      console.error("Error loading sales history:", e);
      setData(null);
      setError(describeIpcError(e, "No se pudo cargar el historial").message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const userStr = sessionStorage.getItem("user");
    if (!userStr) {
      navigate("/");
      return;
    }
    setUser(JSON.parse(userStr));
  }, [navigate]);

  useEffect(() => {
    if (user) load(applied, page);
  }, [user, applied, page, load]);

  useEffect(() => {
    if (detailId === null) {
      setDetail(null);
      setDetailError("");
      return;
    }
    let cancelled = false;
    setDetail(null);
    setDetailError("");
    window.api.sales
      .getDetail(detailId)
      .then((d) => !cancelled && setDetail(d))
      .catch((e) => !cancelled && setDetailError(describeIpcError(e, "No se pudo cargar la venta").message));
    return () => {
      cancelled = true;
    };
  }, [detailId]);

  const search = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    setApplied({ ...form, q: form.q.trim() });
  };
  const reset = () => {
    setForm(EMPTY);
    setApplied(EMPTY);
    setPage(1);
  };

  if (!user) return null;
  const filtered = applied.q || applied.from || applied.to || applied.method;

  return (
    <POSLayout>
      <div className="p-4 md:p-6 max-w-6xl mx-auto">
        <h1 className="text-2xl md:text-3xl font-bold mb-1">Historial de ventas</h1>
        <p className="text-sm text-muted-foreground mb-4">
          {user.role === "admin" ? "Todas las ventas registradas, de la más reciente a la más antigua." : "Tus ventas registradas, de la más reciente a la más antigua."} Consultar o reimprimir un recibo no genera otra venta.
        </p>

        <Card className="p-4 mb-4">
          <form onSubmit={search} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1.2fr_1fr_1fr_1fr_auto] items-end">
            <div>
              <label htmlFor="hs-q" className="text-sm font-semibold block mb-1">Folio</label>
              <div className="relative">
                <Search size={16} className="absolute left-3 top-3.5 text-muted-foreground" />
                <Input id="hs-q" inputMode="numeric" placeholder="Ej. 1042" value={form.q} onChange={(e) => setForm({ ...form, q: e.target.value })} className="pl-9 h-11" />
              </div>
            </div>
            <div>
              <label htmlFor="hs-from" className="text-sm font-semibold block mb-1">Desde</label>
              <Input id="hs-from" type="date" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} className="h-11" />
            </div>
            <div>
              <label htmlFor="hs-to" className="text-sm font-semibold block mb-1">Hasta</label>
              <Input id="hs-to" type="date" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} className="h-11" />
            </div>
            <div>
              <label htmlFor="hs-method" className="text-sm font-semibold block mb-1">Método de pago</label>
              <select id="hs-method" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value as Filters["method"] })} className="h-11 w-full border rounded-md px-3 bg-background">
                <option value="">Todos</option>
                <option value="cash">Efectivo</option>
                <option value="card">Tarjeta</option>
              </select>
            </div>
            <div className="flex gap-2">
              <Button type="submit" className="h-11">Buscar</Button>
              <Button type="button" variant="outline" className="h-11" onClick={reset}>Limpiar</Button>
            </div>
          </form>
        </Card>

        {loading && !data ? (
          <div className="flex justify-center py-16">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
          </div>
        ) : error ? (
          <Card className="text-center py-10 px-4">
            <p role="alert" className="text-red-600 mb-4">{error}</p>
            <Button onClick={() => load(applied, page)}>Reintentar</Button>
          </Card>
        ) : data && data.rows.length === 0 ? (
          <Card className="text-center py-12 px-4">
            <p className="text-muted-foreground">{filtered ? "No hay ventas que coincidan con la búsqueda o los filtros." : "Todavía no hay ventas registradas."}</p>
          </Card>
        ) : data ? (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="table-pos w-full text-sm" aria-label="Ventas">
                <thead>
                  <tr>
                    <th>Folio</th>
                    <th>Fecha</th>
                    <th>Vendedor</th>
                    <th>Pago</th>
                    <th>Unidades</th>
                    <th>Total</th>
                    <th>Estado</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="font-mono font-semibold">#{r.id}</td>
                      <td>{when(r.createdAt)}</td>
                      <td>{r.sellerName ?? "—"}</td>
                      <td>{METHOD_LABEL[r.paymentMethod]}</td>
                      <td>{r.itemCount}</td>
                      <td className="font-bold text-primary">{money(r.total)}</td>
                      <td>{r.returnCount > 0 ? <span className="text-amber-700 font-semibold">Con devolución</span> : "—"}</td>
                      <td>
                        <Button size="sm" variant="outline" className="h-9" onClick={() => setDetailId(r.id)} aria-label={`Ver venta ${r.id}`}>
                          Ver detalle
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 p-3 border-t text-sm">
              <span data-testid="history-summary">
                {data.total} {data.total === 1 ? "venta" : "ventas"} · Página {page} de {data.pageCount}
              </span>
              <div className="flex gap-2">
                <Button variant="outline" className="h-10 gap-1" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)}>
                  <ChevronLeft size={16} /> Anterior
                </Button>
                <Button variant="outline" className="h-10 gap-1" disabled={page >= data.pageCount || loading} onClick={() => setPage((p) => p + 1)}>
                  Siguiente <ChevronRight size={16} />
                </Button>
              </div>
            </div>
          </Card>
        ) : null}
      </div>

      <Dialog open={detailId !== null} onOpenChange={(o) => !o && setDetailId(null)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Venta #{detailId}</DialogTitle>
            <DialogDescription>Datos guardados en la base de datos.</DialogDescription>
          </DialogHeader>
          {detailError ? (
            <p role="alert" className="text-sm text-red-600">{detailError}</p>
          ) : !detail ? (
            <p className="text-sm text-muted-foreground">Cargando...</p>
          ) : (
            <div className="space-y-4">
              <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">
                <div>Fecha: <strong>{when(detail.sale.createdAt)}</strong></div>
                <div>Vendedor: <strong>{detail.sale.sellerName ?? "—"}</strong></div>
                <div>Pago: <strong>{METHOD_LABEL[detail.sale.paymentMethod as "cash" | "card"]}</strong></div>
                <div>
                  Caja: <strong>{detail.cashSession ? `#${detail.cashSession.id}${detail.cashSession.closedAt ? " (cerrada)" : " (abierta)"}` : "—"}</strong>
                </div>
              </div>

              <table className="table-pos w-full text-sm" aria-label="Productos de la venta">
                <thead>
                  <tr><th>Producto</th><th>Cant.</th><th>Precio</th><th>Subtotal</th></tr>
                </thead>
                <tbody>
                  {detail.items.map((i: any) => (
                    <tr key={i.id}>
                      <td>
                        <div className="font-semibold">{i.name}</div>
                        <div className="text-xs text-muted-foreground font-mono">
                          {i.sku ?? "—"}
                          {i.nameSource === "catalog" ? " · nombre actual del catálogo (venta anterior al registro de nombres)" : ""}
                          {i.productStatus === "deleted" ? " · producto eliminado" : ""}
                        </div>
                      </td>
                      <td>{i.quantity}</td>
                      <td>{money(i.unitPrice)}</td>
                      <td>{money(i.subtotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex justify-between text-lg font-bold">
                <span>Total</span>
                <span className="text-primary" data-testid="detail-total">{money(detail.sale.total)}</span>
              </div>

              {detail.returns.length > 0 && (
                <div>
                  <h3 className="font-semibold mb-2">Devoluciones</h3>
                  <ul className="space-y-2 text-sm">
                    {detail.returns.map((r: any) => (
                      <li key={r.id} className="border rounded p-2">
                        <div className="flex justify-between gap-2">
                          <span>Devolución #{r.id} · {when(r.createdAt)}</span>
                          <strong>{money(r.totalRefund ?? 0)}</strong>
                        </div>
                        <div className={r.refundStatus === "pending" ? "text-amber-700 font-semibold" : "text-muted-foreground"}>{REFUND_LABEL[r.refundStatus] ?? r.refundStatus}</div>
                        <div className="text-muted-foreground">Motivo: {r.reason}</div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <Button variant="outline" className="h-11 gap-2" onClick={() => setReceipt({ id: detail.sale.id, copy: false })}>
                  <FileText size={18} /> Ver recibo
                </Button>
                <Button className="h-11 gap-2" onClick={() => setReceipt({ id: detail.sale.id, copy: true })}>
                  <Printer size={18} /> Reimprimir
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ReceiptDialog saleId={receipt?.id ?? null} copy={receipt?.copy ?? false} onClose={() => setReceipt(null)} />
    </POSLayout>
  );
}
