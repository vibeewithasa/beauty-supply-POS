import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { POSLayout } from "@/components/pos-layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { describeIpcError } from "@/lib/ipc-error";
import { toCsv } from "@/lib/csv";

interface User {
  id: number;
  name: string;
  role: "admin" | "vendor";
}
interface Summary {
  from: string;
  to: string;
  days: number;
  sales: { count: number; total: string };
  byMethod: { method: string; count: number; total: string }[];
  byProduct: { productId: number; sku: string | null; name: string | null; quantity: number; total: string }[];
  returns: {
    pending: { count: number; total: string };
    paid: { count: number; total: string };
    legacy: { count: number; total: string };
  };
}

const METHOD_LABEL: Record<string, string> = { cash: "Efectivo", card: "Tarjeta" };
const money = (v: string | number) => `$${Number(v).toFixed(2)}`;

const pad = (n: number) => String(n).padStart(2, "0");
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export default function ReportsPage() {
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>(null);
  const today = localDay(new Date());
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const run = useCallback(async (f: string, t: string) => {
    setLoading(true);
    setError("");
    try {
      setSummary(await window.api.reports.getSummary({ from: f, to: t }));
    } catch (e) {
      console.error("Error loading report:", e);
      setSummary(null);
      setError(describeIpcError(e, "No se pudo generar el reporte").message);
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
    const parsed = JSON.parse(userStr);
    if (parsed.role !== "admin") {
      navigate("/sales");
      return;
    }
    setUser(parsed);
    run(today, today);
  }, [navigate, run, today]);

  const exportCsv = () => {
    if (!summary) return;
    const rows: (string | number)[][] = [
      ["Reporte de ventas", `${summary.from} a ${summary.to}`],
      [],
      ["Resumen", "Operaciones", "Total"],
      ["Ventas", summary.sales.count, summary.sales.total],
      [],
      ["Método de pago", "Operaciones", "Total"],
      ...summary.byMethod.map((m) => [METHOD_LABEL[m.method] ?? m.method, m.count, m.total]),
      [],
      ["SKU", "Producto", "Unidades", "Total"],
      ...summary.byProduct.map((p) => [p.sku ?? "", p.name ?? `#${p.productId}`, p.quantity, p.total]),
      [],
      ["Devoluciones", "Cantidad", "Total"],
      ["Reembolso pendiente", summary.returns.pending.count, summary.returns.pending.total],
      ["Reembolso pagado", summary.returns.paid.count, summary.returns.paid.total],
      ["Anterior al control de reembolsos", summary.returns.legacy.count, summary.returns.legacy.total],
    ];
    const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `reporte-${summary.from}_${summary.to}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast.success("CSV generado localmente");
  };

  if (!user) return null;

  const empty = summary && summary.sales.count === 0 && summary.returns.pending.count + summary.returns.paid.count + summary.returns.legacy.count === 0;

  return (
    <POSLayout>
      <div className="p-6 max-w-5xl mx-auto">
        <h1 className="text-3xl font-bold mb-2">Reportes</h1>
        <p className="text-sm text-muted-foreground mb-6">
          Ventas brutas registradas por rango de fechas. No incluye costos, utilidad ni impuestos porque el sistema no los registra.
        </p>

        <Card className="p-4 mb-6">
          <div className="flex flex-wrap gap-3 items-end">
            <div>
              <label htmlFor="rp-from" className="text-sm font-semibold block mb-1">Desde</label>
              <Input id="rp-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-11" />
            </div>
            <div>
              <label htmlFor="rp-to" className="text-sm font-semibold block mb-1">Hasta</label>
              <Input id="rp-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-11" />
            </div>
            <Button onClick={() => run(from, to)} disabled={loading} className="h-11">
              {loading ? "Generando..." : "Generar reporte"}
            </Button>
            <Button variant="outline" onClick={exportCsv} disabled={!summary || !!empty} className="h-11 gap-2">
              <Download size={16} /> Exportar CSV
            </Button>
          </div>
          {error && <p role="alert" className="text-sm text-red-600 mt-3">{error}</p>}
        </Card>

        {loading && !summary ? (
          <div className="flex justify-center py-16">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
          </div>
        ) : empty ? (
          <Card className="card-pos-stat text-center py-12">
            <p className="text-muted-foreground">No hay ventas ni devoluciones en el rango {summary!.from} a {summary!.to}.</p>
          </Card>
        ) : summary ? (
          <div className="space-y-6">
            <div className="grid sm:grid-cols-2 gap-4">
              <Card className="p-4">
                <div className="text-sm text-muted-foreground">Ventas totales</div>
                <div className="text-3xl font-bold text-primary" data-testid="rp-total">{money(summary.sales.total)}</div>
              </Card>
              <Card className="p-4">
                <div className="text-sm text-muted-foreground">Operaciones</div>
                <div className="text-3xl font-bold" data-testid="rp-count">{summary.sales.count}</div>
              </Card>
            </div>

            <Card className="p-4">
              <h2 className="font-semibold mb-3">Por método de pago</h2>
              <table className="table-pos w-full text-sm">
                <thead><tr><th>Método</th><th>Operaciones</th><th>Total</th></tr></thead>
                <tbody>
                  {summary.byMethod.map((m) => (
                    <tr key={m.method}>
                      <td>{METHOD_LABEL[m.method] ?? m.method}</td>
                      <td>{m.count}</td>
                      <td>{money(m.total)}</td>
                    </tr>
                  ))}
                  {summary.byMethod.length === 0 && <tr><td colSpan={3} className="text-muted-foreground">Sin ventas en el rango.</td></tr>}
                </tbody>
              </table>
            </Card>

            <Card className="p-4">
              <h2 className="font-semibold mb-3">Productos vendidos (top 20 por importe)</h2>
              <table className="table-pos w-full text-sm">
                <thead><tr><th>SKU</th><th>Producto</th><th>Unidades</th><th>Total</th></tr></thead>
                <tbody>
                  {summary.byProduct.map((p) => (
                    <tr key={p.productId}>
                      <td className="font-mono">{p.sku ?? "—"}</td>
                      <td>{p.name ?? `Producto #${p.productId}`}</td>
                      <td>{p.quantity}</td>
                      <td>{money(p.total)}</td>
                    </tr>
                  ))}
                  {summary.byProduct.length === 0 && <tr><td colSpan={4} className="text-muted-foreground">Sin ventas en el rango.</td></tr>}
                </tbody>
              </table>
            </Card>

            <Card className="p-4">
              <h2 className="font-semibold mb-1">Devoluciones registradas en el rango</h2>
              <p className="text-xs text-muted-foreground mb-3">
                Una devolución registrada no es dinero entregado: los reembolsos pendientes siguen debiéndose al cliente.
              </p>
              <table className="table-pos w-full text-sm">
                <thead><tr><th>Estado</th><th>Cantidad</th><th>Total</th></tr></thead>
                <tbody>
                  <tr data-testid="rp-ret-pending">
                    <td className="text-amber-700 font-semibold">Reembolso PENDIENTE</td>
                    <td>{summary.returns.pending.count}</td>
                    <td>{money(summary.returns.pending.total)}</td>
                  </tr>
                  <tr data-testid="rp-ret-paid">
                    <td className="text-green-700 font-semibold">Reembolso pagado</td>
                    <td>{summary.returns.paid.count}</td>
                    <td>{money(summary.returns.paid.total)}</td>
                  </tr>
                  {summary.returns.legacy.count > 0 && (
                    <tr>
                      <td className="text-muted-foreground">Anterior al control de reembolsos (sin especificar)</td>
                      <td>{summary.returns.legacy.count}</td>
                      <td>{money(summary.returns.legacy.total)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </Card>
          </div>
        ) : null}
      </div>
    </POSLayout>
  );
}
