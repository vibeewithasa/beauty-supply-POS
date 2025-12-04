import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { POSLayout } from "@/components/pos-layout";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";

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
  category?: string;
}

export default function StockPage() {
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const userStr = sessionStorage.getItem("user");
    if (!userStr) {
      navigate("/");
      return;
    }
    setUser(JSON.parse(userStr));
    loadProducts();
  }, [navigate]);

  const loadProducts = async () => {
    try {
      setLoading(true);
      const data = await window.api.products.getAll();
      setProducts(data);
    } catch (error) {
      console.error("Error loading products:", error);
    } finally {
      setLoading(false);
    }
  };

  if (!user || loading) {
    return (
      <POSLayout>
        <div className="flex h-screen items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
        </div>
      </POSLayout>
    );
  }

  const filteredProducts = products.filter(
    (p) =>
      p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      p.sku.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <POSLayout>
      <div className="p-8">
        <h1 className="text-3xl font-bold mb-8">Consultar Stock</h1>

        <Card className="p-4 mb-6">
          <div className="relative">
            <Search className="absolute left-3 top-3 text-muted-foreground" size={20} />
            <Input
              placeholder="Buscar por nombre o SKU..."
              value={searchTerm}
              onChange={(e: any) => setSearchTerm(e.target.value)}
              className="pl-10 h-12"
            />
          </div>
        </Card>

        <Card className="p-0 overflow-hidden">
          <table className="table-pos">
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
                const stockStatus =
                  stock === 0 ? "Sin Stock" : stock < 10 ? "Stock Bajo" : "Disponible";
                const stockClass =
                  stock === 0
                    ? "badge-pos-inactive"
                    : stock < 10
                    ? "badge-pos-pending"
                    : "badge-pos-active";

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
                    No se encontraron productos
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>
    </POSLayout>
  );
}
