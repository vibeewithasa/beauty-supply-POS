import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { POSLayout } from "@/components/pos-layout";
import { ReceiptDialog } from "@/components/receipt-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Search, Plus, Minus, Trash2, CreditCard, DollarSign, Printer, AlertCircle, ShoppingCart, FileText } from "lucide-react";
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
  barcode?: string | null;
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

interface CompletedSale {
  id: number;
  total: string;
  paymentMethod: "cash" | "card";
  createdAt: Date | string;
  itemCount: number | null;
}

const METHOD_LABEL = { cash: "Efectivo", card: "Tarjeta" } as const;
const REFRESH_CODES = /^(STOCK_INSUFICIENTE|PRECIO_DESACTUALIZADO|SUBTOTAL_INCORRECTO|TOTAL_INCORRECTO|PRODUCTO_NO_DISPONIBLE|PRODUCTO_NO_ENCONTRADO)$/;
const money = (v: string | number) => `$${Number(v).toFixed(2)}`;
const newOperationId = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `op-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`);

export default function SalesPage() {
  const [user, setUser] = useState<User | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [showPaymentDialog, setShowPaymentDialog] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "card">("cash");
  const [paying, setPaying] = useState(false);
  const [received, setReceived] = useState(""); // cash handed over by the customer: a change aid only, never stored
  const [completed, setCompleted] = useState<CompletedSale | null>(null);
  const [receiptSaleId, setReceiptSaleId] = useState<number | null>(null);
  const [printState, setPrintState] = useState<{ kind: "idle" | "printing" | "printed" | "cancelled" | "failed"; message: string }>({ kind: "idle", message: "" });
  const [cashSession, setCashSession] = useState<CashSession | null>(null);
  const [noCashAlert, setNoCashAlert] = useState(false);
  const [showSearchDropdown, setShowSearchDropdown] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [loading, setLoading] = useState(true);
  const [confirmClear, setConfirmClear] = useState(false);
  const [itemToRemove, setItemToRemove] = useState<number | null>(null);
  const navigate = useNavigate();

  const payingRef = useRef(false); // synchronous guard: state updates are too late to stop a double click
  const operationIdRef = useRef<string | null>(null);

  const focusSearch = useCallback(() => {
    // after the DOM settles (dialogs restore focus to their trigger when they close)
    setTimeout(() => document.getElementById("pos-search")?.focus(), 0);
  }, []);

  // Radix would return focus to the button that opened a dialog; the cashier always wants the search box
  const returnFocus = (e: Event) => {
    e.preventDefault();
    document.getElementById("pos-search")?.focus();
  };

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const [productsData, sessionData] = await Promise.all([window.api.products.getAll(), window.api.cash.getActiveSession()]);
      setProducts(productsData);
      setCashSession(sessionData);
    } catch (error) {
      console.error("Error loading data:", error);
      toast.error("Error al cargar datos");
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
    loadData();
  }, [navigate, loadData]);

  useEffect(() => {
    if (!loading) document.getElementById("pos-search")?.focus();
  }, [loading]);

  // a different cart or payment method is a different checkout attempt: it must not replay an earlier operation id
  useEffect(() => {
    operationIdRef.current = null;
  }, [cart, paymentMethod]);

  const term = searchTerm.trim().toLowerCase();
  const filteredProducts = useMemo(
    () =>
      term
        ? products.filter(
            (p) => p.name.toLowerCase().includes(term) || p.sku.toLowerCase().includes(term) || (p.barcode ?? "").toLowerCase().includes(term)
          )
        : [],
    [products, term]
  );

  const total = cart.reduce((sum, item) => sum + item.subtotal, 0);
  const totalCents = Math.round(total * 100);
  const receivedCents = /^\d{1,9}(\.\d{1,2})?$/.test(received.trim()) ? Math.round(Number(received.trim()) * 100) : null;
  const unitsInCart = cart.reduce((sum, item) => sum + item.quantity, 0);

  const addToCart = (product: Product) => {
    // Visual guard only: the main process re-validates stock, price and total on every sale.
    if (product.stock <= 0) {
      toast.error(`"${product.name}" está agotado`);
      return;
    }
    const price = typeof product.price === "string" ? parseFloat(product.price) : product.price;
    const existing = cart.find((item) => item.productId === product.id);
    if (existing) {
      if (existing.quantity + 1 > product.stock) {
        toast.error(`Solo hay ${product.stock} unidades disponibles`);
        return;
      }
      const quantity = existing.quantity + 1;
      setCart(cart.map((item) => (item.productId === product.id ? { ...item, quantity, subtotal: quantity * item.unitPrice } : item)));
    } else {
      setCart([...cart, { productId: product.id, sku: product.sku, name: product.name, quantity: 1, unitPrice: price, subtotal: price }]);
    }
    // No "added" toast: the cart and its total change right away, and a floating notice would cover the Pay button.
    setSearchTerm("");
    setShowSearchDropdown(false);
    setActiveIndex(-1);
    focusSearch();
  };

  /** Enter in the search box: what a keyboard-wedge (HID) barcode scanner sends after the code. */
  const handleSearchEnter = async () => {
    const raw = searchTerm.trim();
    if (!raw) return;
    const lower = raw.toLowerCase();
    const exact = products.find((p) => (p.barcode ?? "").toLowerCase() === lower || p.sku.toLowerCase() === lower);
    if (exact) return addToCart(exact);
    if (activeIndex >= 0 && filteredProducts[activeIndex]) return addToCart(filteredProducts[activeIndex]);
    if (filteredProducts.length === 1) return addToCart(filteredProducts[0]);
    if (filteredProducts.length > 1) {
      toast.error("Hay varios productos que coinciden: elige uno de la lista");
      return;
    }
    try {
      // the local list may be stale (product created or restocked on another terminal)
      const found = await window.api.products.findBySkuOrBarcode(raw);
      if (found && found.status !== "deleted" && found.stock > 0) addToCart(found);
      else if (found) toast.error(found.stock > 0 ? "Producto no disponible" : `"${found.name}" está agotado`);
      else toast.error(`Producto no encontrado: ${raw}`);
    } catch (error) {
      console.error("Barcode search error:", error);
      toast.error("Error al buscar producto");
    }
  };

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void handleSearchEnter();
    } else if (e.key === "ArrowDown" && filteredProducts.length) {
      e.preventDefault();
      setShowSearchDropdown(true);
      setActiveIndex((i) => Math.min(i + 1, filteredProducts.length - 1));
    } else if (e.key === "ArrowUp" && filteredProducts.length) {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Escape") {
      setShowSearchDropdown(false);
      setActiveIndex(-1);
    }
  };

  const setQuantity = (productId: number, newQuantity: number) => {
    const product = products.find((p) => p.id === productId);
    if (!product) return;
    if (newQuantity > product.stock) {
      toast.error(`Solo hay ${product.stock} unidades disponibles`);
      return;
    }
    setCart((prev) => prev.map((item) => (item.productId === productId ? { ...item, quantity: newQuantity, subtotal: newQuantity * item.unitPrice } : item)));
  };

  // Going from 1 to 0 removes the line, so it asks first; 5 -> 4 and similar do not.
  const decrease = (item: CartItem) => {
    if (item.quantity <= 1) setItemToRemove(item.productId);
    else setQuantity(item.productId, item.quantity - 1);
  };

  const removeItem = () => {
    if (itemToRemove === null) return;
    setCart((prev) => prev.filter((i) => i.productId !== itemToRemove));
    setItemToRemove(null);
    focusSearch();
  };

  const clearCart = () => {
    setCart([]);
    setConfirmClear(false);
    focusSearch();
  };

  const handleStartPayment = () => {
    if (!cashSession) {
      setNoCashAlert(true);
      toast.error("Debes abrir la caja antes de realizar ventas");
      return;
    }
    if (cart.length === 0) return;
    setReceived("");
    setShowPaymentDialog(true);
  };

  const handleCompletePayment = async () => {
    if (!user || !cashSession || cart.length === 0) return;
    if (payingRef.current) return; // double click / double Enter
    payingRef.current = true;
    setPaying(true);
    const operationId = (operationIdRef.current ??= newOperationId());
    try {
      const sale = await window.api.sales.create({
        items: cart.map((item) => ({ productId: item.productId, quantity: item.quantity, unitPrice: item.unitPrice, subtotal: item.subtotal })),
        total,
        paymentMethod,
        sessionId: cashSession.id,
        operationId,
      });
      // The sale is persisted. Everything shown from now on is read back from PostgreSQL.
      let detail: any = null;
      try {
        detail = await window.api.sales.getDetail(sale.id);
      } catch (e) {
        console.error("Could not read back the sale:", e);
      }
      const row = detail?.sale ?? sale;
      setCompleted({
        id: sale.id,
        total: String(row.total),
        paymentMethod: row.paymentMethod,
        createdAt: row.createdAt,
        itemCount: detail ? detail.items.reduce((s: number, i: any) => s + i.quantity, 0) : null,
      });
      setPrintState({ kind: "idle", message: "" });
      operationIdRef.current = null;
      setShowPaymentDialog(false);
      setCart([]);
      setSearchTerm("");
      try {
        setProducts(await window.api.products.getAll());
      } catch (e) {
        console.error("Could not refresh the catalog after the sale:", e);
      }
    } catch (error) {
      console.error("Sale error:", error);
      const { code, message } = describeIpcError(error, "Error al completar la venta");
      toast.error(message);
      setShowPaymentDialog(false);
      // A definitive rejection means no sale exists: the next attempt is a new operation. An unknown outcome
      // (internal error) keeps the id, so retrying the same cart can only ever return the same sale.
      if (code && code !== "ERROR_INTERNO") operationIdRef.current = null;
      try {
        // Stale stock/prices/catalog or a closed cash register: resynchronize what the screen shows (the cart is kept).
        if (code && REFRESH_CODES.test(code)) {
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
    } finally {
      payingRef.current = false;
      setPaying(false);
    }
  };

  const printCompleted = async () => {
    if (!completed || printState.kind === "printing") return;
    setPrintState({ kind: "printing", message: "Preparando impresión..." });
    try {
      const r = await window.api.receipts.print(completed.id);
      setPrintState({ kind: r.status, message: r.status === "printed" ? "Recibo enviado a la impresora." : r.message });
    } catch (error) {
      setPrintState({ kind: "failed", message: describeIpcError(error, "No se pudo imprimir").message });
    }
  };

  const newSale = () => {
    setCompleted(null);
    setPrintState({ kind: "idle", message: "" });
    focusSearch();
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

  const removing = cart.find((i) => i.productId === itemToRemove) ?? null;

  return (
    <POSLayout>
      <div className="p-4 md:p-6 h-full flex flex-col bg-gradient-to-b from-background to-muted/10">
        <div className="flex justify-between items-center mb-4">
          <h1 className="text-2xl md:text-3xl font-bold">Punto de Venta</h1>
          <div className="text-sm text-muted-foreground">
            {cashSession ? <span className="text-green-600 font-semibold">✓ Caja Abierta</span> : <span className="text-red-600 font-semibold">✗ Caja Cerrada</span>}
          </div>
        </div>

        {noCashAlert && (
          <Card className="mb-4 p-4 border-red-200 bg-red-50">
            <div className="flex gap-3 items-start">
              <AlertCircle className="text-red-600 mt-1" size={20} />
              <div className="flex-1">
                <p className="font-semibold text-red-800">No hay caja abierta</p>
                <p className="text-sm text-red-700">Abre la caja en el módulo «Caja» antes de realizar ventas</p>
              </div>
              <button onClick={() => setNoCashAlert(false)} className="ml-auto text-red-600 p-2" aria-label="Cerrar aviso">
                ✕
              </button>
            </div>
          </Card>
        )}

        <div className="flex gap-4 md:gap-6 flex-1 overflow-hidden">
          <div className="w-72 lg:w-80 flex-shrink-0 flex flex-col space-y-4">
            <Card
              className="p-4 relative"
              onBlur={(e) => {
                // closes the list only when focus really leaves the search area (clicking an option keeps it)
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                  setShowSearchDropdown(false);
                  setActiveIndex(-1);
                }
              }}
            >
              <label htmlFor="pos-search" className="text-sm font-semibold block mb-2">
                Escanear o Buscar
              </label>
              <div className="relative">
                <Search className="absolute left-3 top-3.5 text-muted-foreground" size={20} />
                <Input
                  id="pos-search"
                  autoFocus
                  autoComplete="off"
                  placeholder="Código, SKU o nombre..."
                  value={searchTerm}
                  onChange={(e) => {
                    setSearchTerm(e.target.value);
                    setShowSearchDropdown(true);
                    setActiveIndex(-1);
                  }}
                  onFocus={() => setShowSearchDropdown(true)}
                  onKeyDown={onSearchKeyDown}
                  className="pl-10 h-12 text-base"
                />
              </div>

              {showSearchDropdown && term && (
                <div role="listbox" aria-label="Resultados" className="absolute top-24 left-4 right-4 bg-card border border-border rounded-lg shadow-lg z-30 max-h-64 overflow-y-auto">
                  {filteredProducts.length === 0 ? (
                    <p className="p-3 text-sm text-muted-foreground">Sin coincidencias. Pulsa Enter para buscar por código exacto.</p>
                  ) : (
                    filteredProducts.map((product, index) => (
                      <button
                        key={product.id}
                        role="option"
                        aria-selected={index === activeIndex}
                        onMouseDown={(e) => e.preventDefault()} // keep the focus in the search box
                        onClick={() => addToCart(product)}
                        className={`w-full text-left p-3 hover:bg-muted border-b last:border-b-0 transition-colors ${index === activeIndex ? "bg-muted" : ""}`}
                      >
                        <p className="font-semibold text-sm">{product.name}</p>
                        <div className="flex justify-between items-center mt-1">
                          <span className="text-xs text-muted-foreground">
                            {product.sku}
                            {product.stock <= 0 ? " · Agotado" : ` · ${product.stock} disp.`}
                          </span>
                          <span className="text-sm font-bold text-primary">{money(product.price)}</span>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              )}
            </Card>

            <Card className="p-4 bg-muted/40">
              <p className="text-xs text-muted-foreground font-medium">
                El lector de códigos escribe en el campo de búsqueda y pulsa Enter. Con el teclado: ↑ ↓ para elegir y Enter para agregar.
              </p>
            </Card>
          </div>

          <div className="flex-1 min-w-0 flex flex-col bg-card rounded-lg border border-border overflow-hidden shadow-lg">
            <div className="bg-primary text-primary-foreground p-4 md:p-5 font-bold text-lg md:text-xl flex items-center justify-between">
              <span>
                Carrito ({cart.length} {cart.length === 1 ? "artículo" : "artículos"})
              </span>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {cart.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                  <ShoppingCart size={56} className="mb-4 opacity-20" />
                  <p className="font-semibold text-lg">Carrito vacío</p>
                  <p className="text-sm mt-2">Escanea o busca productos para comenzar</p>
                </div>
              ) : (
                cart.map((item) => (
                  <div key={item.productId} className="border border-border rounded-lg p-3 hover:shadow-md transition-shadow" data-testid="cart-line">
                    <div className="flex justify-between items-start mb-2">
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-sm line-clamp-1">{item.name}</p>
                        <p className="text-xs text-muted-foreground mt-1">
                          {item.sku} • {money(item.unitPrice)}
                        </p>
                      </div>
                      <button
                        onClick={() => setItemToRemove(item.productId)}
                        aria-label={`Quitar ${item.name}`}
                        className="text-red-600 hover:text-red-700 hover:bg-red-50 p-2.5 rounded transition-colors"
                      >
                        <Trash2 size={18} />
                      </button>
                    </div>

                    <div className="flex items-center gap-3">
                    <div className="flex items-center justify-between bg-muted rounded p-1 w-44 flex-shrink-0">
                      <button onClick={() => decrease(item)} aria-label={`Disminuir ${item.name}`} className="text-primary hover:bg-primary/10 p-2.5 rounded">
                        <Minus size={18} />
                      </button>
                      <input
                        type="number"
                        min={1}
                        aria-label={`Cantidad de ${item.name}`}
                        value={item.quantity}
                        onChange={(e) => {
                          const n = Number.parseInt(e.target.value);
                          if (Number.isNaN(n)) return;
                          if (n <= 0) setItemToRemove(item.productId);
                          else setQuantity(item.productId, n);
                        }}
                        className="w-16 text-center bg-transparent font-semibold text-sm"
                      />
                      <button onClick={() => setQuantity(item.productId, item.quantity + 1)} aria-label={`Aumentar ${item.name}`} className="text-primary hover:bg-primary/10 p-2.5 rounded">
                        <Plus size={18} />
                      </button>
                    </div>

                    <p className="flex-1 text-right text-base font-bold text-primary">{money(item.subtotal)}</p>
                    </div>
                  </div>
                ))
              )}
            </div>

            {cart.length > 0 && (
              <div className="border-t border-border p-4 md:p-5 space-y-3 bg-muted/30">
                <div className="flex justify-between text-lg font-bold">
                  <span>Total:</span>
                  <span className="text-primary text-2xl" data-testid="cart-total">
                    {money(total)}
                  </span>
                </div>
                <div className="flex gap-3">
                  <Button onClick={() => setConfirmClear(true)} variant="outline" className="flex-1 h-12">
                    Limpiar
                  </Button>
                  <Button onClick={handleStartPayment} className="btn-pos-success flex-1 h-12 text-lg gap-2">
                    <DollarSign size={20} />
                    Pagar
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Limpiar carrito */}
      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent onCloseAutoFocus={returnFocus}>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Limpiar el carrito?</AlertDialogTitle>
            <AlertDialogDescription>
              Se quitarán {cart.length} {cart.length === 1 ? "producto" : "productos"} ({unitsInCart} {unitsInCart === 1 ? "unidad" : "unidades"}) del carrito. No se ha registrado ninguna venta.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={clearCart}>Limpiar carrito</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Quitar un artículo */}
      <AlertDialog open={itemToRemove !== null && removing !== null} onOpenChange={(o) => !o && setItemToRemove(null)}>
        <AlertDialogContent onCloseAutoFocus={returnFocus}>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Quitar este producto?</AlertDialogTitle>
            <AlertDialogDescription>
              {removing ? `${removing.name} · cantidad ${removing.quantity}` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={removeItem}>Quitar producto</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Cobro */}
      <Dialog open={showPaymentDialog} onOpenChange={(o) => !paying && setShowPaymentDialog(o)}>
        <DialogContent className="max-w-md" onCloseAutoFocus={returnFocus} onInteractOutside={(e) => paying && e.preventDefault()} onEscapeKeyDown={(e) => paying && e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>Método de Pago</DialogTitle>
          </DialogHeader>
          <div className="space-y-6">
            <div className="text-center">
              <p className="text-muted-foreground mb-2">Total a Pagar</p>
              <p className="text-5xl font-bold text-primary">{money(total)}</p>
            </div>

            <Tabs value={paymentMethod} onValueChange={(value) => !paying && setPaymentMethod(value as "cash" | "card")}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="cash" className="gap-2 h-10">
                  <DollarSign size={18} />
                  Efectivo
                </TabsTrigger>
                <TabsTrigger value="card" className="gap-2 h-10">
                  <CreditCard size={18} />
                  Tarjeta
                </TabsTrigger>
              </TabsList>
            </Tabs>

            {paymentMethod === "cash" && (
              <div className="space-y-2">
                <label htmlFor="cash-received" className="text-sm font-semibold block">
                  Efectivo recibido <span className="font-normal text-muted-foreground">(opcional, para calcular el cambio)</span>
                </label>
                <Input id="cash-received" inputMode="decimal" autoComplete="off" placeholder="0.00" value={received} onChange={(e) => setReceived(e.target.value)} disabled={paying} className="h-12 text-lg" />
                {receivedCents !== null && (
                  <p data-testid="change-due" className={`text-lg rounded p-2 text-center ${receivedCents >= totalCents ? "bg-green-50 text-green-800" : "bg-amber-50 text-amber-900"}`}>
                    {receivedCents >= totalCents ? (
                      <>
                        Cambio a entregar: <strong>{money((receivedCents - totalCents) / 100)}</strong>
                      </>
                    ) : (
                      <>Faltan {money((totalCents - receivedCents) / 100)}</>
                    )}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">Es solo una ayuda: no se guarda en la venta ni cambia la caja.</p>
              </div>
            )}

            <Button onClick={handleCompletePayment} disabled={paying} className="btn-pos-success w-full h-12 text-lg">
              {paying ? "Procesando..." : "Completar Venta"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Venta completada: no se cierra por accidente; solo con una acción visible */}
      <Dialog open={completed !== null} onOpenChange={() => undefined}>
        <DialogContent
          className="max-w-md"
          showCloseButton={false}
          onCloseAutoFocus={returnFocus}
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Venta Completada</DialogTitle>
          </DialogHeader>
          {completed && (
            <div className="space-y-4">
              <div className="bg-green-50 rounded-lg p-5 text-center">
                <p className="text-sm text-green-700 font-semibold">✓ Venta registrada</p>
                <p className="text-sm text-green-700 font-semibold mt-2">Folio</p>
                <p className="text-lg font-bold text-green-700 mb-2" data-testid="sale-folio">
                  #{completed.id}
                </p>
                <p className="text-5xl font-bold text-green-700" data-testid="sale-total">
                  {money(completed.total)}
                </p>
                <p className="text-sm text-green-700 mt-2">
                  {completed.itemCount !== null ? `${completed.itemCount} ${completed.itemCount === 1 ? "unidad" : "unidades"} • ` : ""}
                  {METHOD_LABEL[completed.paymentMethod]}
                </p>
                <p className="text-xs text-green-700 mt-1">{new Date(completed.createdAt).toLocaleString()}</p>
              </div>

              {printState.kind !== "idle" && (
                <p
                  role="status"
                  data-testid="print-status"
                  className={`text-sm rounded p-2 ${printState.kind === "printed" ? "bg-green-50 text-green-800" : printState.kind === "printing" ? "bg-muted" : "bg-amber-50 text-amber-900"}`}
                >
                  {printState.message}
                  {(printState.kind === "failed" || printState.kind === "cancelled") && " La venta ya quedó registrada; puedes volver a imprimir o hacerlo después desde el Historial."}
                </p>
              )}

              <div className="grid grid-cols-2 gap-2">
                <Button onClick={() => setReceiptSaleId(completed.id)} variant="outline" className="gap-2 h-11">
                  <FileText size={18} />
                  Ver recibo
                </Button>
                <Button onClick={printCompleted} disabled={printState.kind === "printing"} variant="outline" className="gap-2 h-11">
                  <Printer size={18} />
                  {printState.kind === "printing" ? "Imprimiendo..." : "Imprimir"}
                </Button>
              </div>
              <Button onClick={newSale} className="btn-pos-primary w-full h-12">
                Nueva venta
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ReceiptDialog saleId={receiptSaleId} onClose={() => setReceiptSaleId(null)} />
    </POSLayout>
  );
}
