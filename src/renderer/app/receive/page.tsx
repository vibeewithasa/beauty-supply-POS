import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { POSLayout } from "@/components/pos-layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";
import { toast } from "sonner";
import { describeIpcError } from "@/lib/ipc-error";

interface User {
  id: number;
  name: string;
  role: "admin" | "vendor";
}
interface Product {
  id: number;
  sku: string;
  name: string;
  stock: number;
  barcode: string | null;
  status: "active" | "inactive" | "deleted";
}
type MovementType = "IN" | "OUT" | "ADJUST";

const TYPE_HELP: Record<MovementType, string> = {
  IN: "Entrada: suma al stock la cantidad indicada (positiva).",
  OUT: "Salida: resta del stock la cantidad indicada (por mermas, consumo interno, etc.).",
  ADJUST: "Ajuste: diferencia con signo (por ejemplo +3 o -2) tras un conteo físico.",
};
const when = (d: string | Date) => new Date(d).toLocaleString();

export default function ReceivePage() {
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [type, setType] = useState<MovementType>("IN");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ text: string } | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [historyError, setHistoryError] = useState("");

  const loadProducts = useCallback(async () => {
    try {
      setLoadError("");
      const all: Product[] = await window.api.products.listAdmin();
      const usable = all.filter((p) => p.status !== "deleted");
      setProducts(usable);
      return usable;
    } catch (error) {
      console.error("Error loading products:", error);
      setLoadError(describeIpcError(error, "No se pudieron cargar los productos").message);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const loadHistory = useCallback(async (productId: number) => {
    try {
      setHistoryError("");
      setHistory(await window.api.inventory.getMovements(productId));
    } catch (error) {
      setHistory([]);
      setHistoryError(describeIpcError(error, "No se pudo cargar el historial").message);
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
    loadProducts();
  }, [navigate, loadProducts]);

  const selected = products.find((p) => p.id === selectedId) ?? null;

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products.slice(0, 8);
    return products
      .filter((p) => [p.sku, p.name, p.barcode ?? ""].some((x) => x.toLowerCase().includes(q)))
      .slice(0, 8);
  }, [products, search]);

  // delta that will be stored: IN positive, OUT negative, ADJUST as typed (signed)
  const parsedQty = /^[+-]?\d+$/.test(quantity.trim()) ? Number(quantity.trim()) : null;
  const delta = parsedQty === null ? null : type === "IN" ? parsedQty : type === "OUT" ? -parsedQty : parsedQty;
  const quantityError = (() => {
    if (quantity.trim() === "") return "";
    if (parsedQty === null || parsedQty === 0) return "Indica un entero distinto de cero";
    if (type !== "ADJUST" && parsedQty < 0) return "Para entradas y salidas escribe la cantidad en positivo";
    return "";
  })();
  const resulting = selected && delta !== null && !quantityError ? selected.stock + delta : null;

  const select = (p: Product) => {
    setSelectedId(p.id);
    setResult(null);
    setQuantity("");
    setReason("");
    loadHistory(p.id);
  };

  const submit = async () => {
    if (!selected) return;
    if (delta === null || quantityError || parsedQty === null) {
      toast.error(quantityError || "Indica una cantidad válida");
      return;
    }
    if (!reason.trim()) {
      toast.error("Indica el motivo del movimiento");
      return;
    }
    if (resulting !== null && resulting < 0) {
      toast.error(`Stock insuficiente: hay ${selected.stock} y el movimiento es ${delta}`);
      return;
    }
    setSaving(true);
    const before = selected.stock;
    try {
      await window.api.inventory.addMovement({ productId: selected.id, type, amount: delta, reason });
      const fresh = await loadProducts();
      const persisted = fresh?.find((p) => p.id === selected.id);
      setResult({
        text: `Movimiento registrado (${type} ${delta > 0 ? "+" : ""}${delta}). Stock persistido: ${persisted?.stock ?? "?"} (antes: ${before}).`,
      });
      toast.success("Movimiento de inventario registrado");
      setQuantity("");
      setReason("");
      await loadHistory(selected.id);
    } catch (error) {
      console.error("Error recording movement:", error);
      toast.error(describeIpcError(error, "No se pudo registrar el movimiento").message);
      await loadProducts(); // the stock shown may be outdated
    } finally {
      setSaving(false);
    }
  };

  if (!user) return null;

  return (
    <POSLayout>
      <div className="p-6 max-w-5xl mx-auto">
        <h1 className="text-3xl font-bold mb-2">Recepción y Ajustes de Inventario</h1>
        <p className="text-sm text-muted-foreground mb-6">
          Entradas, salidas y ajustes de stock con motivo. No registra compras a proveedores ni facturas.
        </p>

        {loading ? (
          <div className="flex justify-center py-16">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
          </div>
        ) : loadError ? (
          <Card className="card-pos-stat text-center py-12">
            <p className="text-red-600 mb-4">{loadError}</p>
            <Button onClick={() => { setLoading(true); loadProducts(); }}>Reintentar</Button>
          </Card>
        ) : (
          <div className="grid md:grid-cols-2 gap-6">
            <Card className="p-4">
              <div className="flex gap-2 items-center mb-3">
                <Search size={18} className="text-muted-foreground" />
                <Input
                  aria-label="Buscar producto"
                  placeholder="SKU, nombre o código de barras..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-11"
                />
              </div>
              {products.length === 0 ? (
                <p className="text-sm text-muted-foreground">No hay productos. Créalos en «Productos».</p>
              ) : matches.length === 0 ? (
                <p className="text-sm text-muted-foreground">Sin coincidencias.</p>
              ) : (
                <ul className="space-y-2">
                  {matches.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => select(p)}
                        aria-label={`Seleccionar ${p.name}`}
                        className={`w-full text-left rounded border p-3 hover:bg-accent ${p.id === selectedId ? "border-primary bg-accent" : ""}`}
                      >
                        <div className="font-semibold">{p.name}</div>
                        <div className="text-xs text-muted-foreground font-mono">
                          {p.sku} · stock {p.stock}
                          {p.status === "inactive" ? " · inactivo" : ""}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card className="p-4">
              {!selected ? (
                <p className="text-muted-foreground text-center py-12">Selecciona un producto para registrar un movimiento.</p>
              ) : (
                <div className="space-y-3">
                  <div>
                    <div className="text-lg font-bold">{selected.name}</div>
                    <div className="text-sm text-muted-foreground font-mono">{selected.sku}</div>
                    <div className="mt-1">
                      Stock actual: <strong data-testid="current-stock">{selected.stock}</strong>
                    </div>
                  </div>
                  <div>
                    <label htmlFor="mv-type" className="text-sm font-semibold block mb-1">Tipo de movimiento</label>
                    <select
                      id="mv-type"
                      value={type}
                      onChange={(e) => { setType(e.target.value as MovementType); setQuantity(""); }}
                      className="h-10 w-full border rounded-md px-3 bg-background"
                    >
                      <option value="IN">Entrada (IN)</option>
                      <option value="OUT">Salida (OUT)</option>
                      <option value="ADJUST">Ajuste (ADJUST)</option>
                    </select>
                    <p className="text-xs text-muted-foreground mt-1">{TYPE_HELP[type]}</p>
                  </div>
                  <div>
                    <label htmlFor="mv-qty" className="text-sm font-semibold block mb-1">
                      {type === "ADJUST" ? "Diferencia (con signo)" : "Cantidad"}
                    </label>
                    <Input id="mv-qty" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
                    {quantityError && <p className="text-xs text-red-600 mt-1">{quantityError}</p>}
                    {resulting !== null && (
                      <p className={`text-sm mt-1 ${resulting < 0 ? "text-red-600" : ""}`}>
                        Stock resultante: <strong>{resulting}</strong>
                        {resulting < 0 ? " (no permitido: el stock no puede ser negativo)" : ""}
                      </p>
                    )}
                  </div>
                  <div>
                    <label htmlFor="mv-reason" className="text-sm font-semibold block mb-1">Motivo</label>
                    <Input id="mv-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
                  </div>
                  <Button onClick={submit} disabled={saving} className="btn-pos-success w-full h-12">
                    {saving ? "Registrando..." : "Registrar movimiento"}
                  </Button>
                  {result && (
                    <p role="status" data-testid="movement-result" className="text-sm bg-green-50 text-green-800 rounded p-3">
                      {result.text}
                    </p>
                  )}
                </div>
              )}
            </Card>
          </div>
        )}

        {selected && (
          <Card className="p-4 mt-6">
            <h2 className="font-semibold mb-3">Historial reciente de {selected.name}</h2>
            {historyError ? (
              <p className="text-sm text-red-600">{historyError}</p>
            ) : history.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sin movimientos registrados.</p>
            ) : (
              <div className="max-h-72 overflow-y-auto">
                <table className="table-pos w-full text-sm">
                  <thead>
                    <tr><th>Fecha</th><th>Tipo</th><th>Cantidad</th><th>Motivo</th><th>Usuario</th></tr>
                  </thead>
                  <tbody>
                    {history.map((m) => (
                      <tr key={m.id}>
                        <td>{when(m.createdAt)}</td>
                        <td>{m.type}</td>
                        <td className={m.amount < 0 ? "text-red-600 font-semibold" : "text-green-600 font-semibold"}>{m.amount > 0 ? `+${m.amount}` : m.amount}</td>
                        <td>{m.reason}</td>
                        <td>{m.userName ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}
      </div>
    </POSLayout>
  );
}
