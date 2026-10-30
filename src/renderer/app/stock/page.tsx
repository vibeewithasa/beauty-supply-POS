import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { POSLayout } from "@/components/pos-layout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";
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
  price: string;
  stock: number;
  barcode?: string | null;
  category?: string | null;
}

const LOW_STOCK = 10;

export default function StockPage() {
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [onlyLow, setOnlyLow] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadProducts = useCallback(async () => {
    try {
      setLoading(true);
      setError("");
      setProducts(await window.api.products.getAll());
    } catch (e) {
      console.error("Error loading products:", e);
      setError(describeIpcError(e, "No se pudo cargar el inventario").message);
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
    loadProducts();
  }, [navigate, loadProducts]);

  if (!user || loading) {
    return (
      <POSLayout>
        <div className="flex h-screen items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
        </div>
      </POSLayout>
    );
  }

  const term = searchTerm.trim().toLowerCase();
  const filteredProducts = products.filter(
    (p) =>
      (!onlyLow || p.stock < LOW_STOCK) &&
      (!term || p.name.toLowerCase().includes(term) || p.sku.toLowerCase().includes(term) || (p.barcode ?? "").toLowerCase().includes(term))
  );

  return (
    <POSLayout>
      <div className="p-4 md:p-6">
        <h1 className="text-2xl md:text-3xl font-bold mb-4">Consultar Stock</h1>

        <Card className="p-4 mb-4">
          <div className="flex flex-wrap gap-3 items-center">
            <div className="relative flex-1 min-w-60">
              <Search className="absolute left-3 top-3.5 text-muted-foreground" size={20} />
              <Input
                aria-label="Buscar en el inventario"
                placeholder="Buscar por nombre, SKU o código de barras..."
                value={searchTerm}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchTerm(e.target.value)}
                className="pl-10 h-12"
              />
            </div>
            <label className="flex items-center gap-2 text-sm min-h-11">
              <input type="checkbox" checked={onlyLow} onChange={(e) => setOnlyLow(e.target.checked)} className="h-5 w-5" />
              Solo stock bajo (menos de {LOW_STOCK})
            </label>
          </div>
        </Card>

        {error ? (
          <Card className="text-center py-10 px-4">
            <p role="alert" className="text-red-600 mb-4">{error}</p>
            <Button onClick={loadProducts}>Reintentar</Button>
          </Card>
        ) : (
          <Card className="p-0 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="table-pos w-full" aria-label="Inventario">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Producto</th>
                    <th>Categoría</th>
                    <th>Precio</th>
                    <th>Stock</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredProducts.map((product) => {
                    const stock = product.stock;
                    const stockStatus = stock === 0 ? "Sin Stock" : stock < LOW_STOCK ? "Stock Bajo" : "Disponible";
                    const stockClass = stock === 0 ? "badge-pos-inactive" : stock < LOW_STOCK ? "badge-pos-pending" : "badge-pos-active";
                    return (
                      <tr key={product.id}>
                        <td className="font-mono text-sm">{product.sku}</td>
                        <td className="font-semibold">{product.name}</td>
                        <td className="text-sm">{product.category || "Sin categoría"}</td>
                        <td className="text-primary font-bold">${parseFloat(product.price).toFixed(2)}</td>
                        <td className="font-semibold">{stock} unidades</td>
                        <td>
                          <span className={stockClass}>{stockStatus}</span>
                        </td>
                      </tr>
                    );
                  })}
                  {filteredProducts.length === 0 && (
                    <tr>
                      <td colSpan={6} className="text-center text-muted-foreground py-8">
                        {products.length === 0 ? "Aún no hay productos activos." : "No se encontraron productos"}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </POSLayout>
  );
}
