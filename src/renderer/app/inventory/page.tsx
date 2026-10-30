import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { POSLayout } from "@/components/pos-layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Plus, Search, History, DollarSign, Trash2, Edit2 } from "lucide-react";
import { toast } from "sonner";
import { describeIpcError } from "@/lib/ipc-error";

interface User {
  id: number;
  name: string;
  role: "admin" | "vendor";
}

type Status = "active" | "inactive" | "deleted";

interface Product {
  id: number;
  sku: string;
  name: string;
  price: string;
  stock: number;
  barcode: string | null;
  category: string | null;
  status: Status;
}

const STATUS_LABEL: Record<Status, string> = {
  active: "Activo",
  inactive: "Inactivo",
  deleted: "Eliminado",
};
const money = (v: string | number) => `$${Number(v).toFixed(2)}`;
const when = (d: string | Date) => new Date(d).toLocaleString();

const EMPTY_FORM = { sku: "", name: "", category: "", barcode: "", status: "active" as "active" | "inactive", price: "", stock: "0" };

export default function InventoryPage() {
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"visible" | Status | "all">("visible");

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const [priceTarget, setPriceTarget] = useState<Product | null>(null);
  const [newPrice, setNewPrice] = useState("");
  const [priceReason, setPriceReason] = useState("");
  const [priceHistory, setPriceHistory] = useState<any[]>([]);

  const [historyTarget, setHistoryTarget] = useState<Product | null>(null);
  const [movements, setMovements] = useState<any[]>([]);

  const [deleteTarget, setDeleteTarget] = useState<Product | null>(null);
  const [deleteReason, setDeleteReason] = useState("");

  const load = useCallback(async () => {
    try {
      setLoadError("");
      const data: Product[] = await window.api.products.listAdmin();
      setProducts(data);
      return data;
    } catch (error) {
      console.error("Error loading products:", error);
      setLoadError(describeIpcError(error, "No se pudieron cargar los productos").message);
      return null;
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
    load();
  }, [navigate, load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      if (statusFilter === "visible" ? p.status === "deleted" : statusFilter !== "all" && p.status !== statusFilter) return false;
      if (!q) return true;
      return [p.sku, p.name, p.barcode ?? "", p.category ?? ""].some((x) => x.toLowerCase().includes(q));
    });
  }, [products, search, statusFilter]);

  if (!user) return null;

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormOpen(true);
  };
  const openEdit = (p: Product) => {
    setEditing(p);
    setForm({ sku: p.sku, name: p.name, category: p.category ?? "", barcode: p.barcode ?? "", status: p.status === "inactive" ? "inactive" : "active", price: "", stock: "0" });
    setFormOpen(true);
  };

  const saveProduct = async () => {
    if (!form.sku.trim() || !form.name.trim()) {
      toast.error("SKU y nombre son obligatorios");
      return;
    }
    if (!editing) {
      if (!/^\d+(\.\d{1,2})?$/.test(form.price.trim())) {
        toast.error("El precio debe ser un importe válido con hasta 2 decimales");
        return;
      }
      if (!/^\d+$/.test(form.stock.trim() || "0")) {
        toast.error("El stock inicial debe ser un entero mayor o igual a 0");
        return;
      }
    }
    setSaving(true);
    try {
      if (editing) {
        // stock and price are NOT editable here: they change through inventory movements / price changes
        await window.api.products.update(editing.id, {
          sku: form.sku,
          name: form.name,
          category: form.category,
          barcode: form.barcode,
          status: form.status,
        });
        toast.success("Producto actualizado");
      } else {
        await window.api.products.create({
          sku: form.sku,
          name: form.name,
          category: form.category,
          barcode: form.barcode,
          status: form.status,
          price: form.price.trim(),
          stock: Number(form.stock.trim() || "0"),
        });
        toast.success("Producto creado");
      }
      setFormOpen(false);
      await load();
    } catch (error) {
      console.error("Error saving product:", error);
      toast.error(describeIpcError(error, "No se pudo guardar el producto").message);
      if (describeIpcError(error, "").code === "PRODUCTO_ELIMINADO") await load();
    } finally {
      setSaving(false);
    }
  };

  const openPrice = async (p: Product) => {
    setPriceTarget(p);
    setNewPrice("");
    setPriceReason("");
    setPriceHistory([]);
    // the current price is read again from PostgreSQL when the dialog opens
    const fresh = await load();
    const current = fresh?.find((x) => x.id === p.id);
    if (current) setPriceTarget(current);
    try {
      setPriceHistory(await window.api.priceChanges.getAll(p.id));
    } catch (error) {
      toast.error(describeIpcError(error, "No se pudo cargar el historial de precios").message);
    }
  };

  const savePrice = async () => {
    if (!priceTarget) return;
    if (!/^\d+(\.\d{1,2})?$/.test(newPrice.trim())) {
      toast.error("El precio nuevo debe ser un importe válido con hasta 2 decimales");
      return;
    }
    setSaving(true);
    try {
      await window.api.priceChanges.create({
        productId: priceTarget.id,
        newPrice: newPrice.trim(),
        oldPrice: priceTarget.price, // only a staleness check: the recorded old price comes from PostgreSQL
        reason: priceReason,
      });
      const fresh = await load();
      const current = fresh?.find((x) => x.id === priceTarget.id);
      toast.success(`Precio actualizado: ${money(priceTarget.price)} → ${money(current?.price ?? newPrice)}`);
      setPriceTarget(null);
    } catch (error) {
      console.error("Error changing price:", error);
      const { code, message } = describeIpcError(error, "No se pudo cambiar el precio");
      toast.error(message);
      if (code === "PRECIO_DESACTUALIZADO") {
        const fresh = await load();
        const current = fresh?.find((x) => x.id === priceTarget.id);
        if (current) setPriceTarget(current);
      }
    } finally {
      setSaving(false);
    }
  };

  const openHistory = async (p: Product) => {
    setHistoryTarget(p);
    setMovements([]);
    try {
      setMovements(await window.api.inventory.getMovements(p.id));
    } catch (error) {
      toast.error(describeIpcError(error, "No se pudo cargar el historial").message);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    if (!deleteReason.trim()) {
      toast.error("Indica el motivo de la eliminación");
      return;
    }
    setSaving(true);
    try {
      await window.api.products.softDelete(deleteTarget.id, deleteReason);
      toast.success("Producto eliminado lógicamente (el historial se conserva)");
      setDeleteTarget(null);
      await load();
    } catch (error) {
      console.error("Error deleting product:", error);
      toast.error(describeIpcError(error, "No se pudo eliminar el producto").message);
      await load();
    } finally {
      setSaving(false);
    }
  };

  const field = (id: string, label: string, el: React.ReactNode) => (
    <div>
      <label htmlFor={id} className="text-sm font-semibold block mb-1">
        {label}
      </label>
      {el}
    </div>
  );

  return (
    <POSLayout>
      <div className="p-4 md:p-6">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl md:text-3xl font-bold">Gestión de Productos</h1>
          <Button onClick={openCreate} className="btn-pos-primary gap-2 h-12">
            <Plus size={20} />
            Nuevo Producto
          </Button>
        </div>

        <Card className="p-4 mb-6">
          <div className="flex gap-3 items-center">
            <Search className="text-muted-foreground" size={20} />
            <Input
              placeholder="Buscar por SKU, nombre o código de barras..."
              aria-label="Buscar productos"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-12 flex-1"
            />
            <select
              aria-label="Filtrar por estado"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
              className="h-12 border rounded-md px-3 bg-background"
            >
              <option value="visible">Activos e inactivos</option>
              <option value="active">Solo activos</option>
              <option value="inactive">Solo inactivos</option>
              <option value="deleted">Eliminados</option>
              <option value="all">Todos</option>
            </select>
          </div>
        </Card>

        {loading ? (
          <div className="flex justify-center py-16">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
          </div>
        ) : loadError ? (
          <Card className="card-pos-stat text-center py-12">
            <p className="text-red-600 mb-4">{loadError}</p>
            <Button onClick={() => { setLoading(true); load(); }}>Reintentar</Button>
          </Card>
        ) : filtered.length === 0 ? (
          <Card className="card-pos-stat text-center py-12">
            <p className="text-muted-foreground">
              {products.length === 0 ? "Aún no hay productos. Crea el primero con «Nuevo Producto»." : "No hay productos que coincidan con la búsqueda o el filtro."}
            </p>
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <table className="table-pos w-full">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Producto</th>
                  <th>Categoría</th>
                  <th>Código de barras</th>
                  <th>Precio</th>
                  <th>Stock</th>
                  <th>Estado</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => (
                  <tr key={p.id} className={p.status === "deleted" ? "opacity-60" : ""}>
                    <td className="font-mono text-sm">{p.sku}</td>
                    <td className="font-semibold">{p.name}</td>
                    <td className="text-sm">{p.category || "—"}</td>
                    <td className="font-mono text-sm">{p.barcode || "—"}</td>
                    <td className="text-primary font-bold">{money(p.price)}</td>
                    <td>{p.stock}</td>
                    <td>{STATUS_LABEL[p.status]}</td>
                    <td>
                      <div className="flex gap-1 flex-wrap">
                        <Button size="sm" variant="outline" className="h-10" onClick={() => openHistory(p)} aria-label={`Historial de ${p.name}`}>
                          <History size={14} /> Historial
                        </Button>
                        {p.status !== "deleted" && (
                          <>
                            <Button size="sm" variant="outline" className="h-10" onClick={() => openEdit(p)} aria-label={`Editar ${p.name}`}>
                              <Edit2 size={14} /> Editar
                            </Button>
                            <Button size="sm" variant="outline" className="h-10" onClick={() => openPrice(p)} aria-label={`Cambiar precio de ${p.name}`}>
                              <DollarSign size={14} /> Precio
                            </Button>
                            <Button size="sm" variant="destructive" className="h-10" onClick={() => { setDeleteTarget(p); setDeleteReason(""); }} aria-label={`Eliminar ${p.name}`}>
                              <Trash2 size={14} /> Eliminar
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>

      {/* Crear / editar */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Editar producto" : "Nuevo producto"}</DialogTitle>
            <DialogDescription>
              {editing
                ? "El stock se modifica en Recepción y el precio con «Precio»; no se editan aquí."
                : "El stock inicial queda registrado como una entrada en el historial."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {field("pf-sku", "SKU", <Input id="pf-sku" value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} />)}
            {field("pf-name", "Nombre", <Input id="pf-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />)}
            {field("pf-category", "Categoría", <Input id="pf-category" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />)}
            {field("pf-barcode", "Código de barras", <Input id="pf-barcode" value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.target.value })} />)}
            {field(
              "pf-status",
              "Estado",
              <select id="pf-status" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as "active" | "inactive" })} className="h-10 w-full border rounded-md px-3 bg-background">
                <option value="active">Activo (se vende)</option>
                <option value="inactive">Inactivo (no se vende)</option>
              </select>
            )}
            {!editing && (
              <div className="grid grid-cols-2 gap-3">
                {field("pf-price", "Precio inicial", <Input id="pf-price" inputMode="decimal" placeholder="0.00" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />)}
                {field("pf-stock", "Stock inicial", <Input id="pf-stock" inputMode="numeric" value={form.stock} onChange={(e) => setForm({ ...form, stock: e.target.value })} />)}
              </div>
            )}
            <Button onClick={saveProduct} disabled={saving} className="btn-pos-success w-full h-12">
              {saving ? "Guardando..." : editing ? "Guardar cambios" : "Crear producto"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Cambio de precio */}
      <Dialog open={!!priceTarget} onOpenChange={(o) => !o && setPriceTarget(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Cambiar precio</DialogTitle>
            <DialogDescription>{priceTarget ? `${priceTarget.sku} · ${priceTarget.name}` : ""}</DialogDescription>
          </DialogHeader>
          {priceTarget && (
            <div className="space-y-3">
              <p className="text-lg">
                Precio actual (leído de la base de datos): <strong data-testid="current-price">{money(priceTarget.price)}</strong>
              </p>
              {field("pc-new", "Precio nuevo", <Input id="pc-new" inputMode="decimal" placeholder="0.00" value={newPrice} onChange={(e) => setNewPrice(e.target.value)} />)}
              {field("pc-reason", "Motivo (opcional)", <Input id="pc-reason" value={priceReason} onChange={(e) => setPriceReason(e.target.value)} />)}
              <Button onClick={savePrice} disabled={saving} className="btn-pos-success w-full h-12">
                {saving ? "Guardando..." : "Registrar cambio de precio"}
              </Button>
              <h3 className="font-semibold pt-2">Historial de precios</h3>
              {priceHistory.length === 0 ? (
                <p className="text-sm text-muted-foreground">Este producto aún no tiene cambios de precio registrados.</p>
              ) : (
                <div className="max-h-48 overflow-y-auto">
                  <table className="table-pos w-full text-sm">
                    <thead>
                      <tr><th>Fecha</th><th>Anterior</th><th>Nuevo</th><th>Usuario</th><th>Motivo</th></tr>
                    </thead>
                    <tbody>
                      {priceHistory.map((h) => (
                        <tr key={h.id}>
                          <td>{when(h.createdAt)}</td>
                          <td>{money(h.oldPrice)}</td>
                          <td>{money(h.newPrice)}</td>
                          <td>{h.userName ?? "—"}</td>
                          <td>{h.reason ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Historial de movimientos */}
      <Dialog open={!!historyTarget} onOpenChange={(o) => !o && setHistoryTarget(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Historial de movimientos</DialogTitle>
            <DialogDescription>{historyTarget ? `${historyTarget.sku} · ${historyTarget.name}` : ""}</DialogDescription>
          </DialogHeader>
          {movements.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sin movimientos registrados.</p>
          ) : (
            <div className="max-h-80 overflow-y-auto">
              <table className="table-pos w-full text-sm">
                <thead>
                  <tr><th>Fecha</th><th>Tipo</th><th>Cantidad</th><th>Motivo</th><th>Usuario</th></tr>
                </thead>
                <tbody>
                  {movements.map((m) => (
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
        </DialogContent>
      </Dialog>

      {/* Baja lógica */}
      <Dialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Eliminar producto</DialogTitle>
            <DialogDescription>
              {deleteTarget ? `${deleteTarget.sku} · ${deleteTarget.name}` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-red-700 bg-red-50 rounded p-3">
              Baja lógica: el producto deja de venderse y su stock pasa a 0 (se registra un movimiento de baja). No se
              borra físicamente y el historial de ventas se conserva. Esta acción no se puede deshacer desde la aplicación.
            </p>
            {field("pd-reason", "Motivo", <Input id="pd-reason" value={deleteReason} onChange={(e) => setDeleteReason(e.target.value)} />)}
            <div className="flex gap-3">
              <Button variant="outline" className="flex-1" onClick={() => setDeleteTarget(null)}>
                Cancelar
              </Button>
              <Button variant="destructive" className="flex-1" disabled={saving} onClick={confirmDelete}>
                {saving ? "Eliminando..." : "Confirmar eliminación"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </POSLayout>
  );
}
