import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { POSLayout } from "@/components/pos-layout";
import { DocumentDialog } from "@/components/document-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ArrowLeft, ChevronLeft, ChevronRight, Download, FileText } from "lucide-react";
import { toast } from "sonner";
import { describeIpcError } from "@/lib/ipc-error";
import { toCsv } from "@/lib/csv";

interface User {
  id: number;
  name: string;
  role: "admin" | "vendor";
}
interface Row {
  id: number;
  status: string;
  openedAt: Date | string;
  closedAt: Date | string | null;
  openedByName: string | null;
  closedByName: string | null;
  finalAmount: string | null;
  salesCount: number;
  cashSales: string;
  cardSales: string;
  difference: string | null;
}
interface Filters {
  from: string;
  to: string;
  status: "" | "open" | "closed";
}

const PAGE_SIZE = 20;
const EMPTY: Filters = { from: "", to: "", status: "" };
const money = (v: string | number) => `$${Number(v).toFixed(2)}`;
// sign before the currency symbol: -$4.25, +$7.00 (never "$-4.25")
const signed = (v: string) => (Number(v) < 0 ? "-" : Number(v) > 0 ? "+" : "") + money(Math.abs(Number(v)));
const when = (d: Date | string | null) => (d ? new Date(d).toLocaleString() : "—");
const diffClass = (v: string | null) => (v === null ? "" : Number(v) < 0 ? "text-red-600 font-semibold" : Number(v) > 0 ? "text-amber-700 font-semibold" : "text-green-700 font-semibold");
const diffLabel = (v: string) => (Number(v) < 0 ? "Faltante" : Number(v) > 0 ? "Sobrante" : "Sin diferencia");

export default function CashHistoryPage() {
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
  const [printId, setPrintId] = useState<number | null>(null);

  const load = useCallback(async (f: Filters, p: number) => {
    setLoading(true);
    setError("");
    try {
      setData(await window.api.cash.listSessions({ page: p, pageSize: PAGE_SIZE, from: f.from || undefined, to: f.to || undefined, status: f.status || undefined }));
    } catch (e) {
      console.error("Error loading cash sessions:", e);
      setData(null);
      setError(describeIpcError(e, "No se pudo cargar el historial de caja").message);
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
    window.api.cash
      .getSessionSummary(detailId)
      .then((d) => !cancelled && setDetail(d))
      .catch((e) => !cancelled && setDetailError(describeIpcError(e, "No se pudo cargar la sesión").message));
    return () => {
      cancelled = true;
    };
  }, [detailId]);

  const exportCsv = () => {
    if (!detail) return;
    const d = detail;
    const rows: (string | number)[][] = [
      [`Corte de caja #${d.session.id}`, d.session.status === "closed" ? "Cerrada" : "Abierta"],
      ["Apertura", new Date(d.session.openedAt).toISOString(), d.session.openedByName ?? ""],
      ["Cierre", d.session.closedAt ? new Date(d.session.closedAt).toISOString() : "", d.session.closedByName ?? ""],
      [],
      ["Concepto", "Cantidad", "Importe"],
      ["Efectivo inicial", "", d.initialAmount],
      ["Ventas en efectivo", d.sales.cash.count, d.sales.cash.total],
      ["Otros ingresos", d.movements.manualIn.count, d.movements.manualIn.total],
      ["Retiros", d.movements.manualOut.count, d.movements.manualOut.total],
      ["Efectivo esperado al cierre (saldo de caja)", "", d.expected.registerBalance],
      ["Efectivo esperado según registros", "", d.expected.fromRecords],
      ["Efectivo contado", "", d.closing.counted ?? ""],
      ["Diferencia", "", d.closing.difference ?? ""],
      ["Ventas con tarjeta (informativo)", d.sales.card.count, d.sales.card.total],
      ["Total de ventas", d.sales.count, ""],
      ["Reembolsos pendientes (no pagados)", d.returns.pending.count, d.returns.pending.total],
      ["Reembolsos pagados", d.returns.paid.count, d.returns.paid.total],
      ["Devoluciones anteriores al control", d.returns.legacy.count, d.returns.legacy.total],
    ];
    const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `corte-de-caja-${d.session.id}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast.success("CSV generado localmente");
  };

  const search = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    setApplied(form);
  };

  if (!user) return null;
  const filtered = applied.from || applied.to || applied.status;

  return (
    <POSLayout>
      <div className="p-4 md:p-6 max-w-6xl mx-auto">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
          <h1 className="text-2xl md:text-3xl font-bold">Historial de caja</h1>
          <Link to="/cash">
            <Button variant="outline" className="gap-2 h-11">
              <ArrowLeft size={18} />
              Volver a Caja
            </Button>
          </Link>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Sesiones de la caja compartida, de la más reciente a la más antigua.{" "}
          {user.role === "admin" ? "" : "Ves la sesión abierta y las que tú abriste o cerraste. "}
          Consultar, exportar o imprimir un corte no modifica la caja.
        </p>

        <Card className="p-4 mb-4">
          <form onSubmit={search} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_auto] items-end">
            <div>
              <label htmlFor="ch-from" className="text-sm font-semibold block mb-1">Desde</label>
              <Input id="ch-from" type="date" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} className="h-11" />
            </div>
            <div>
              <label htmlFor="ch-to" className="text-sm font-semibold block mb-1">Hasta</label>
              <Input id="ch-to" type="date" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} className="h-11" />
            </div>
            <div>
              <label htmlFor="ch-status" className="text-sm font-semibold block mb-1">Estado</label>
              <select id="ch-status" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as Filters["status"] })} className="h-11 w-full border rounded-md px-3 bg-background">
                <option value="">Todas</option>
                <option value="open">Abierta</option>
                <option value="closed">Cerradas</option>
              </select>
            </div>
            <div className="flex gap-2">
              <Button type="submit" className="h-11">Buscar</Button>
              <Button type="button" variant="outline" className="h-11" onClick={() => { setForm(EMPTY); setApplied(EMPTY); setPage(1); }}>Limpiar</Button>
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
            <p className="text-muted-foreground">{filtered ? "No hay sesiones de caja que coincidan con los filtros." : "Todavía no hay sesiones de caja registradas."}</p>
          </Card>
        ) : data ? (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="table-pos w-full text-sm" aria-label="Sesiones de caja">
                <thead>
                  <tr>
                    <th>Sesión</th>
                    <th>Apertura</th>
                    <th>Cierre</th>
                    <th>Abrió / cerró</th>
                    <th>Ventas</th>
                    <th>Efectivo</th>
                    <th>Tarjeta</th>
                    <th>Contado</th>
                    <th>Diferencia</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="font-mono font-semibold">#{r.id}</td>
                      <td>{when(r.openedAt)}</td>
                      <td>{r.closedAt ? when(r.closedAt) : <span className="text-green-700 font-semibold">Abierta</span>}</td>
                      <td>{r.openedByName ?? "—"}{r.closedByName ? ` / ${r.closedByName}` : ""}</td>
                      <td>{r.salesCount}</td>
                      <td>{money(r.cashSales)}</td>
                      <td className="text-muted-foreground">{money(r.cardSales)}</td>
                      <td>{r.finalAmount !== null ? money(r.finalAmount) : "—"}</td>
                      <td className={diffClass(r.difference)}>{r.difference !== null ? signed(r.difference) : "—"}</td>
                      <td>
                        <Button size="sm" variant="outline" className="h-10" aria-label={`Ver sesión ${r.id}`} onClick={() => setDetailId(r.id)}>
                          Ver resumen
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 p-3 border-t text-sm">
              <span data-testid="cash-history-summary">
                {data.total} {data.total === 1 ? "sesión" : "sesiones"} · Página {page} de {data.pageCount}
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
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Corte de caja #{detailId}</DialogTitle>
            <DialogDescription>Cifras calculadas desde la base de datos: ventas por método, movimientos manuales y cierre.</DialogDescription>
          </DialogHeader>
          {detailError ? (
            <p role="alert" className="text-sm text-red-600">{detailError}</p>
          ) : !detail ? (
            <p className="text-sm text-muted-foreground">Cargando...</p>
          ) : (
            <div className="space-y-4 text-sm">
              <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1">
                <div>Apertura: <strong>{when(detail.session.openedAt)}</strong></div>
                <div>Abrió: <strong>{detail.session.openedByName ?? "—"}</strong></div>
                <div>Cierre: <strong>{detail.session.closedAt ? when(detail.session.closedAt) : "Sesión abierta"}</strong></div>
                <div>Cerró: <strong>{detail.session.closedByName ?? "—"}</strong></div>
              </div>

              <section aria-label="Efectivo" className="space-y-1">
                <h3 className="font-semibold">Efectivo</h3>
                <Line label="Efectivo inicial" value={money(detail.initialAmount)} id="cs-initial" />
                <Line label={`Ventas en efectivo (${detail.sales.cash.count})`} value={money(detail.sales.cash.total)} id="cs-cash-sales" />
                <Line label={`Otros ingresos (${detail.movements.manualIn.count})`} value={money(detail.movements.manualIn.total)} id="cs-manual-in" />
                <Line label={`Retiros (${detail.movements.manualOut.count})`} value={"-" + money(detail.movements.manualOut.total)} id="cs-manual-out" />
                <Line label={detail.session.closedAt ? "Efectivo esperado al cierre" : "Efectivo esperado ahora"} value={money(detail.expected.registerBalance)} id="cs-expected" strong />
                {detail.closing.counted !== null && <Line label="Efectivo contado" value={money(detail.closing.counted)} id="cs-counted" />}
                {detail.closing.difference !== null && (
                  <div className="flex justify-between text-base">
                    <span className="font-semibold">Diferencia ({diffLabel(detail.closing.difference)})</span>
                    <strong data-testid="cs-difference" className={diffClass(detail.closing.difference)}>{signed(detail.closing.difference)}</strong>
                  </div>
                )}
                {!detail.expected.reconciles && (
                  <p role="alert" data-testid="cs-unreconciled" className="rounded border border-amber-400 bg-amber-50 p-2 text-amber-900">
                    Los registros ({money(detail.expected.fromRecords)}) no concilian con el saldo de caja ({money(detail.expected.registerBalance)}). Son datos anteriores o inconsistentes: revisa los movimientos.
                  </p>
                )}
              </section>

              <section aria-label="Ventas" className="space-y-1">
                <h3 className="font-semibold">Ventas</h3>
                <Line label="Total de ventas" value={String(detail.sales.count)} id="cs-sales-count" />
                <Line label={`Con tarjeta (${detail.sales.card.count})`} value={money(detail.sales.card.total)} id="cs-card-sales" />
                <p className="text-xs text-muted-foreground">Las ventas con tarjeta son informativas: no entran al efectivo de la caja.</p>
              </section>

              {(detail.returns.pending.count > 0 || detail.returns.paid.count > 0 || detail.returns.legacy.count > 0) && (
                <section aria-label="Devoluciones" className="space-y-1">
                  <h3 className="font-semibold">Devoluciones registradas de estas ventas</h3>
                  {detail.returns.pending.count > 0 && <Line label={`Reembolsos PENDIENTES (${detail.returns.pending.count})`} value={money(detail.returns.pending.total)} id="cs-returns-pending" />}
                  {detail.returns.paid.count > 0 && <Line label={`Reembolsos pagados (${detail.returns.paid.count})`} value={money(detail.returns.paid.total)} id="cs-returns-paid" />}
                  {detail.returns.legacy.count > 0 && <Line label={`Anteriores al control de reembolsos (${detail.returns.legacy.count})`} value={money(detail.returns.legacy.total)} id="cs-returns-legacy" />}
                  <p className="text-xs text-amber-800">Un reembolso pendiente es dinero que se debe al cliente: NO está pagado ni descontado de la caja.</p>
                </section>
              )}

              <div className="grid grid-cols-2 gap-2">
                <Button variant="outline" className="h-11 gap-2" onClick={exportCsv}>
                  <Download size={18} /> Exportar CSV
                </Button>
                <Button className="h-11 gap-2" onClick={() => setPrintId(detail.session.id)}>
                  <FileText size={18} /> Vista imprimible
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <DocumentDialog
        key={printId ?? "none"}
        open={printId !== null}
        title={`Corte de caja #${printId}`}
        description="Documento interno, no fiscal. Imprimir no modifica la caja."
        iframeTitle="Vista previa del corte de caja"
        sentLabel="Corte enviado a imprimir"
        load={() => window.api.cash.previewSummary(printId as number)}
        print={() => window.api.cash.printSummary(printId as number)}
        onClose={() => setPrintId(null)}
      />
    </POSLayout>
  );
}

function Line({ label, value, id, strong = false }: { label: string; value: string; id: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? "text-base" : ""}`}>
      <span className={strong ? "font-semibold" : ""}>{label}</span>
      <strong data-testid={id}>{value}</strong>
    </div>
  );
}
