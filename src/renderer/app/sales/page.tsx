import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { POSLayout } from "@/components/pos-layout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Search,
  Plus,
  Minus,
  Trash2,
  CreditCard,
  DollarSign,
  Printer,
  AlertCircle,
  ShoppingCart,
} from "lucide-react";
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
  price: string;
  barcode?: string;
  stock: number;
}

interface CartItem {
  productId: number;
  sku: string;
  name: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
}

interface CashSession {
  id: number;
  openedBy: number;
  initialAmount: string;
  currentAmount: string;
  openedAt: Date;
}

export default function SalesPage() {
  const [user, setUser] = useState<User | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [barcodeScan, setBarcodeScan] = useState("");
  const [showPaymentDialog, setShowPaymentDialog] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "card">("cash");
  const [showReceiptDialog, setShowReceiptDialog] = useState(false);
  const [lastSale, setLastSale] = useState<{
    id: number;
    total: number;
    items: number;
    method: string;
    timestamp: string;
  } | null>(null);
  const [cashSession, setCashSession] = useState<CashSession | null>(null);
  const [noCashAlert, setNoCashAlert] = useState(false);
  const [showSearchDropdown, setShowSearchDropdown] = useState(false);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    const userStr = sessionStorage.getItem("user");
    if (!userStr) {
      navigate("/");
      return;
    }
    const parsedUser = JSON.parse(userStr);
    setUser(parsedUser);

    loadData();
  }, [navigate]);

  const loadData = async () => {
    try {
      setLoading(true);
      const [productsData, sessionData] = await Promise.all([
        window.api.products.getAll(),
        window.api.cash.getActiveSession(),
      ]);
      setProducts(productsData);
      setCashSession(sessionData);
    } catch (error) {
      console.error("Error loading data:", error);
      toast.error("Error al cargar datos");
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
      p.sku.toLowerCase().includes(searchTerm.toLowerCase()) ||
      p.barcode?.includes(searchTerm)
  );

  const handleBarcodeInput = async (input: string) => {
    try {
      const product = await window.api.products.findBySkuOrBarcode(input);
      if (product && product.stock > 0) {
        addToCart(product);
      } else if (!product) {
        toast.error("Producto no encontrado");
      } else {
        toast.error("Producto sin stock");
      }
    } catch (error) {
      console.error("Barcode search error:", error);
      toast.error("Error al buscar producto");
    }
    setBarcodeScan("");
  };

  const addToCart = (product: Product) => {
    // Visual guard only: the main process re-validates stock, price and total on every sale.
    if (product.stock <= 0) {
      toast.error(`"${product.name}" está agotado`);
      return;
    }
    const price =
      typeof product.price === "string"
        ? parseFloat(product.price)
        : product.price;
    const existingItem = cart.find((item) => item.productId === product.id);
    if (existingItem) {
      if (existingItem.quantity + 1 > product.stock) {
        toast.error(`Solo hay ${product.stock} unidades disponibles`);
        return;
      }
      const newQuantity = existingItem.quantity + 1;
      setCart(
        cart.map((item) =>
          item.productId === product.id
            ? {
                ...item,
                quantity: newQuantity,
                subtotal: newQuantity * item.unitPrice,
              }
            : item
        )
      );
    } else {
      setCart([
        ...cart,
        {
          productId: product.id,
          sku: product.sku,
          name: product.name,
          quantity: 1,
          unitPrice: price,
          subtotal: price,
        },
      ]);
    }
    setSearchTerm("");
    setShowSearchDropdown(false);
    toast.success(`${product.name} agregado al carrito`);
  };

  const updateQuantity = (productId: number, newQuantity: number) => {
    const product = products.find((p) => p.id === productId);
    if (!product) return;

    if (newQuantity <= 0) {
      removeFromCart(productId);
    } else if (newQuantity > product.stock) {
      toast.error(`Solo hay ${product.stock} unidades disponibles`);
    } else {
      setCart(
        cart.map((item) =>
          item.productId === productId
            ? {
                ...item,
                quantity: newQuantity,
                subtotal: newQuantity * item.unitPrice,
              }
            : item
        )
      );
    }
  };

  const removeFromCart = (productId: number) => {
    setCart(cart.filter((item) => item.productId !== productId));
  };

  const total = cart.reduce((sum, item) => sum + item.subtotal, 0);

  const handleStartPayment = () => {
    if (!cashSession) {
      setNoCashAlert(true);
      toast.error("Debes abrir la caja antes de realizar ventas");
      return;
    }
    setShowPaymentDialog(true);
  };

  const handleCompletePayment = async () => {
    if (!user || !cashSession) return;

    try {
      const saleData = {
        items: cart.map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          subtotal: item.subtotal,
        })),
        total,
        paymentMethod,
        sessionId: cashSession.id,
      };

      const sale = await window.api.sales.create(saleData);

      setLastSale({
        id: sale.id,
        total,
        items: cart.length,
        method: paymentMethod === "cash" ? "Efectivo" : "Tarjeta",
        timestamp: new Date().toLocaleTimeString(),
      });

      toast.success("Venta completada exitosamente");
      setShowPaymentDialog(false);
      setShowReceiptDialog(true);
      setCart([]);
      setSearchTerm("");

      // Reload products to update stock
      const updatedProducts = await window.api.products.getAll();
      setProducts(updatedProducts);
    } catch (error) {
      console.error("Sale error:", error);
      const { code, message } = describeIpcError(error, "Error al completar la venta");
      toast.error(message);
      setShowPaymentDialog(false);
      try {
        // Stale stock/prices/catalog or a closed cash register: resynchronize what the screen shows.
        if (code && /^(STOCK_INSUFICIENTE|PRECIO_DESACTUALIZADO|SUBTOTAL_INCORRECTO|TOTAL_INCORRECTO|PRODUCTO_NO_DISPONIBLE|PRODUCTO_NO_ENCONTRADO)$/.test(code)) {
          const fresh: Product[] = await window.api.products.getAll();
          setProducts(fresh);
          setCart((prev) =>
            prev.flatMap((item) => {
              const p = fresh.find((x) => x.id === item.productId);
              if (!p || p.stock <= 0) return [];
              const quantity = Math.min(item.quantity, p.stock);
              const unitPrice = parseFloat(p.price);
              return [{ ...item, quantity, unitPrice, subtotal: Math.round(quantity * unitPrice * 100) / 100 }];
            })
          );
        } else if (code && code.startsWith("CAJA_")) {
          setCashSession(await window.api.cash.getActiveSession());
        }
      } catch (refreshError) {
        console.error("Refresh after rejected sale failed:", refreshError);
      }
    }
  };

  const handlePrintReceipt = () => {
    window.print();
  };

  return (
    <POSLayout>
      <div className="p-6 h-full flex flex-col bg-gradient-to-b from-background to-muted/10">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-3xl font-bold">Punto de Venta</h1>
          <div className="text-sm text-muted-foreground">
            {cashSession ? (
              <span className="text-green-600 font-semibold">
                ✓ Caja Abierta
              </span>
            ) : (
              <span className="text-red-600 font-semibold">✗ Caja Cerrada</span>
            )}
          </div>
        </div>

        {noCashAlert && (
          <Card className="mb-4 p-4 border-red-200 bg-red-50">
            <div className="flex gap-3 items-start">
              <AlertCircle className="text-red-600 mt-1" size={20} />
              <div className="flex-1">
                <p className="font-semibold text-red-800">
                  No hay caja abierta
                </p>
                <p className="text-sm text-red-700">
                  Debes abrir la caja antes de realizar ventas
                </p>
              </div>
              <button
                onClick={() => setNoCashAlert(false)}
                className="ml-auto text-red-600"
              >
                ✕
              </button>
            </div>
          </Card>
        )}

        <div className="flex gap-6 flex-1 overflow-hidden">
          <div className="w-80 flex flex-col space-y-4">
            <Card className="p-4 relative">
              <label className="text-sm font-semibold block mb-2">
                Escanear o Buscar
              </label>
              <div className="relative">
                <Search
                  className="absolute left-3 top-3 text-muted-foreground"
                  size={20}
                />
                <Input
                  placeholder="Código, SKU o nombre..."
                  value={searchTerm}
                  onChange={(e) => {
                    setSearchTerm(e.target.value);
                    setShowSearchDropdown(true);
                  }}
                  onFocus={() => setShowSearchDropdown(true)}
                  onBlur={() =>
                    setTimeout(() => setShowSearchDropdown(false), 200)
                  }
                  className="pl-10 h-12 text-base"
                />
              </div>

              {showSearchDropdown &&
                searchTerm &&
                filteredProducts.length > 0 && (
                  <div className="absolute top-24 left-4 right-4 bg-card border border-border rounded-lg shadow-lg z-50 max-h-64 overflow-y-auto">
                    {filteredProducts.map((product) => (
                      <button
                        key={product.id}
                        onClick={() => addToCart(product)}
                        className="w-full text-left p-3 hover:bg-muted border-b last:border-b-0 transition-colors"
                      >
                        <p className="font-semibold text-sm">{product.name}</p>
                        <div className="flex justify-between items-center mt-1">
                          <span className="text-xs text-muted-foreground">
                            {product.sku}
                            {product.stock <= 0 ? " · Agotado" : ""}
                          </span>
                          <span className="text-sm font-bold text-primary">
                            $
                            {typeof product.price === "string"
                              ? product.price
                              : parseFloat(product.price).toFixed(2)}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}

              <input
                type="text"
                placeholder="Escanear código de barras..."
                value={barcodeScan}
                onChange={(e) => setBarcodeScan(e.target.value)}
                onKeyPress={(e) => {
                  if (e.key === "Enter" && barcodeScan.trim()) {
                    handleBarcodeInput(barcodeScan);
                  }
                }}
                className="hidden"
              />
            </Card>

            <Card className="p-4 bg-blue-50 border-blue-200">
              <p className="text-xs text-blue-700 font-medium">
                💡 Escanea códigos con el lector o busca manualmente
              </p>
            </Card>
          </div>

          <div className="flex-1 flex flex-col bg-card rounded-lg border border-border overflow-hidden shadow-lg">
            <div className="bg-primary text-primary-foreground p-6 font-bold text-xl flex items-center justify-between">
              <span>
                Carrito ({cart.length}{" "}
                {cart.length === 1 ? "artículo" : "artículos"})
              </span>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {cart.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                  <ShoppingCart size={56} className="mb-4 opacity-20" />
                  <p className="font-semibold text-lg">Carrito vacío</p>
                  <p className="text-sm mt-2">
                    Escanea o busca productos para comenzar
                  </p>
                </div>
              ) : (
                cart.map((item) => (
                  <div
                    key={item.productId}
                    className="border border-border rounded-lg p-4 hover:shadow-md transition-shadow"
                  >
                    <div className="flex justify-between items-start mb-3">
                      <div className="flex-1">
                        <p className="font-semibold text-sm line-clamp-1">
                          {item.name}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          {item.sku} • ${item.unitPrice.toFixed(2)}
                        </p>
                      </div>
                      <button
                        onClick={() => removeFromCart(item.productId)}
                        className="text-red-600 hover:text-red-700 hover:bg-red-50 p-2 rounded transition-colors"
                      >
                        <Trash2 size={18} />
                      </button>
                    </div>

                    <div className="flex items-center justify-between bg-muted rounded p-2">
                      <button
                        onClick={() =>
                          updateQuantity(item.productId, item.quantity - 1)
                        }
                        className="text-primary hover:bg-primary/10 p-1 rounded"
                      >
                        <Minus size={18} />
                      </button>
                      <input
                        type="number"
                        value={item.quantity}
                        onChange={(e) =>
                          updateQuantity(
                            item.productId,
                            Number.parseInt(e.target.value) || 1
                          )
                        }
                        className="w-16 text-center bg-transparent font-semibold text-sm"
                      />
                      <button
                        onClick={() =>
                          updateQuantity(item.productId, item.quantity + 1)
                        }
                        className="text-primary hover:bg-primary/10 p-1 rounded"
                      >
                        <Plus size={18} />
                      </button>
                    </div>

                    <p className="text-right text-sm font-bold text-primary mt-3">
                      ${item.subtotal.toFixed(2)}
                    </p>
                  </div>
                ))
              )}
            </div>

            {cart.length > 0 && (
              <div className="border-t border-border p-6 space-y-4 bg-muted/30">
                <div className="space-y-2">
                  <div className="flex justify-between text-lg font-bold">
                    <span>Total:</span>
                    <span className="text-primary text-2xl">
                      ${total.toFixed(2)}
                    </span>
                  </div>
                </div>

                <div className="flex gap-3 pt-2">
                  <Button
                    onClick={() => setCart([])}
                    variant="outline"
                    className="flex-1 h-12"
                  >
                    Limpiar
                  </Button>
                  <Button
                    onClick={handleStartPayment}
                    className="btn-pos-success flex-1 h-12 text-lg gap-2"
                  >
                    <DollarSign size={20} />
                    Pagar
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <Dialog open={showPaymentDialog} onOpenChange={setShowPaymentDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Método de Pago</DialogTitle>
          </DialogHeader>
          <div className="space-y-6">
            <div className="text-center">
              <p className="text-muted-foreground mb-2">Total a Pagar</p>
              <p className="text-5xl font-bold text-primary">
                ${total.toFixed(2)}
              </p>
            </div>

            <Tabs
              value={paymentMethod}
              onValueChange={(value) =>
                setPaymentMethod(value as "cash" | "card")
              }
            >
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="cash" className="gap-2">
                  <DollarSign size={18} />
                  Efectivo
                </TabsTrigger>
                <TabsTrigger value="card" className="gap-2">
                  <CreditCard size={18} />
                  Tarjeta
                </TabsTrigger>
              </TabsList>
            </Tabs>

            <Button
              onClick={handleCompletePayment}
              className="btn-pos-success w-full h-12 text-lg"
            >
              Completar Venta
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showReceiptDialog} onOpenChange={setShowReceiptDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Venta Completada</DialogTitle>
          </DialogHeader>
          {lastSale && (
            <div className="space-y-4">
              <div className="bg-green-50 rounded-lg p-6 text-center">
                <p className="text-sm text-green-600 font-semibold">ID Venta</p>
                <p className="text-lg font-bold text-green-600 mb-3">
                  #{lastSale.id}
                </p>
                <p className="text-5xl font-bold text-green-600">
                  ${lastSale.total.toFixed(2)}
                </p>
                <p className="text-sm text-green-600 mt-2">
                  {lastSale.items} items • {lastSale.method}
                </p>
                <p className="text-xs text-green-600 mt-2">
                  {lastSale.timestamp}
                </p>
              </div>

              <div className="flex gap-2">
                <Button
                  onClick={() => window.print()}
                  variant="outline"
                  className="flex-1 gap-2 bg-transparent"
                >
                  <Printer size={18} />
                  Imprimir
                </Button>
                <Button
                  onClick={() => setShowReceiptDialog(false)}
                  className="btn-pos-primary flex-1"
                >
                  Nueva Venta
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </POSLayout>
  );
}
