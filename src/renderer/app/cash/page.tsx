import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { POSLayout } from "@/components/pos-layout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { History, Plus } from "lucide-react";
import { toast } from "sonner";
import { describeIpcError } from "@/lib/ipc-error";

interface User {
  id: number;
  name: string;
  role: "admin" | "vendor";
}

interface CashSession {
  id: number;
  openedBy: number;
  initialAmount: string;
  currentAmount: string;
  finalAmount?: string;
  openedAt: Date;
  closedAt?: Date | null;
}

interface CashMovement {
  id: number;
  sessionId: number;
  type: "IN" | "OUT";
  amount: string;
  reason: string;
  userId: number;
  userName?: string;
  createdAt: Date;
}

export default function CashPage() {
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<CashSession | null>(null);
  const [movements, setMovements] = useState<CashMovement[]>([]);
  // structured totals of the open session (sales by method come from the sales rows, not from the movement text)
  const [summary, setSummary] = useState<any>(null);
  const [showOpenDialog, setShowOpenDialog] = useState(false);
  const [showMovementDialog, setShowMovementDialog] = useState(false);
  const [showCloseDialog, setShowCloseDialog] = useState(false);
  const [openingAmount, setOpeningAmount] = useState("");
  const [movementType, setMovementType] = useState<"IN" | "OUT">("IN");
  const [movementAmount, setMovementAmount] = useState("");
  const [movementReason, setMovementReason] = useState("");
  const [actualAmount, setActualAmount] = useState("");
  const [loading, setLoading] = useState(true);

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
      const sessionData = await window.api.cash.getActiveSession();
      if (sessionData) {
        setSession(sessionData);
        const [movementsData, summaryData] = await Promise.all([
          window.api.cash.getMovements(sessionData.id),
          window.api.cash.getSessionSummary(sessionData.id),
        ]);
        setMovements(movementsData);
        setSummary(summaryData);
      }
    } catch (error) {
      console.error("Error loading cash data:", error);
      toast.error("Error al cargar datos de caja");
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

  // Calcular totales
  const currentAmount = session ? parseFloat(session.currentAmount) : 0;
  const initialAmount = session ? parseFloat(session.initialAmount) : 0;

  // Ventas por método: tomadas de las ventas de la sesión (no del texto de los movimientos)
  const salesCash = summary ? parseFloat(summary.sales.cash.total) : 0;
  const salesCard = summary ? parseFloat(summary.sales.card.total) : 0;
  // Reembolsos pagados desde esta caja (efectivo salió de la caja; tarjeta se hizo en la terminal y no resta efectivo)
  const refundsCash = summary ? parseFloat(summary.refunds.cash.total) : 0;

  const handleOpenCash = async () => {
    if (!user) return;
    const amount = parseFloat(openingAmount);
    if (isNaN(amount) || amount < 0) {
      toast.error("Ingresa un monto válido");
      return;
    }

    try {
      const newSession = await window.api.cash.openSession(amount);
      setSession(newSession);
      setMovements([]);
      setOpeningAmount("");
      setShowOpenDialog(false);
      toast.success("Caja abierta exitosamente");
    } catch (error) {
      console.error("Error opening cash:", error);
      const { code, message } = describeIpcError(error, "Error al abrir caja");
      toast.error(message);
      if (code === "CAJA_YA_ABIERTA") await loadData();
    }
  };

  const handleAddMovement = async () => {
    if (!user || !session) return;
    const amount = parseFloat(movementAmount);
    if (isNaN(amount) || amount <= 0 || !movementReason.trim()) {
      toast.error("Completa todos los campos correctamente");
      return;
    }

    try {
      await window.api.cash.addMovement({
        sessionId: session.id,
        type: movementType,
        amount,
        reason: movementReason,
      });

      // Reload session and movements to get updated data with user names
      const [updatedSession, updatedMovements, updatedSummary] = await Promise.all([
        window.api.cash.getActiveSession(),
        window.api.cash.getMovements(session.id),
        window.api.cash.getSessionSummary(session.id),
      ]);

      if (updatedSession) setSession(updatedSession);
      setMovements(updatedMovements);
      setSummary(updatedSummary);

      setMovementAmount("");
      setMovementReason("");
      setShowMovementDialog(false);
      toast.success(
        `Movimiento de ${
          movementType === "IN" ? "entrada" : "salida"
        } registrado`
      );
    } catch (error) {
      console.error("Error adding movement:", error);
      const { code, message } = describeIpcError(error, "Error al registrar movimiento");
      toast.error(message);
      if (code === "CAJA_CERRADA") {
        setSession(null);
        setMovements([]);
        setShowMovementDialog(false);
      }
    }
  };

  const handleCloseCash = async () => {
    if (!user || !session) return;
    const actualAmount_num = parseFloat(actualAmount);
    if (isNaN(actualAmount_num) || actualAmount_num < 0) {
      toast.error("Ingresa un monto válido");
      return;
    }

    try {
      await window.api.cash.closeSession(session.id, actualAmount_num);
      const difference = actualAmount_num - currentAmount;
      setSession(null);
      setMovements([]);
      setActualAmount("");
      setShowCloseDialog(false);
      toast.success(`Caja cerrada. Diferencia: $${difference.toFixed(2)}`);
    } catch (error) {
      console.error("Error closing cash:", error);
      const { code, message } = describeIpcError(error, "Error al cerrar caja");
      toast.error(message);
      if (code === "CAJA_CERRADA") {
        setSession(null);
        setMovements([]);
        setShowCloseDialog(false);
      }
    }
  };

  return (
    <POSLayout>
      <div className="p-4 md:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
          <h1 className="text-2xl md:text-3xl font-bold">Gestión de Caja</h1>
          <Link to="/cash/history">
            <Button variant="outline" className="gap-2 h-11">
              <History size={18} />
              Historial de sesiones
            </Button>
          </Link>
        </div>

        {!session ? (
          <Card className="card-pos-stat max-w-md mx-auto">
            <div className="text-center py-12">
              <p className="text-muted-foreground mb-6">
                No hay sesión de caja abierta
              </p>
              <Button
                onClick={() => setShowOpenDialog(true)}
                className="btn-pos-primary"
              >
                Abrir Caja
              </Button>
            </div>
          </Card>
        ) : (
          <div className="space-y-6">
            {/* Status */}
            <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-4">
              <Card className="card-pos-stat">
                <div>
                  <p className="card-pos-stat-label">Monto Inicial</p>
                  <p className="card-pos-stat-value mt-2">
                    ${initialAmount.toFixed(2)}
                  </p>
                </div>
              </Card>
              <Card className="card-pos-stat">
                <div>
                  <p className="card-pos-stat-label">Total en Caja</p>
                  <p className="card-pos-stat-value mt-2">
                    ${currentAmount.toFixed(2)}
                  </p>
                </div>
              </Card>
              <Card className="card-pos-stat">
                <div>
                  <p className="card-pos-stat-label">Ventas Efectivo</p>
                  <p className="card-pos-stat-value mt-2 text-green-600">
                    ${salesCash.toFixed(2)}
                  </p>
                </div>
              </Card>
              <Card className="card-pos-stat">
                <div>
                  <p className="card-pos-stat-label">Ventas Tarjeta</p>
                  <p className="card-pos-stat-value mt-2 text-blue-600">
                    ${salesCard.toFixed(2)}
                  </p>
                </div>
              </Card>
              <Card className="card-pos-stat">
                <div>
                  <p className="card-pos-stat-label">Reembolsos Efectivo</p>
                  <p className="card-pos-stat-value mt-2 text-red-600" data-testid="cash-refunds">
                    -${refundsCash.toFixed(2)}
                  </p>
                </div>
              </Card>
              <Card className="card-pos-stat">
                <div>
                  <p className="card-pos-stat-label">Movimientos</p>
                  <p className="card-pos-stat-value mt-2">{movements.length}</p>
                </div>
              </Card>
              <Card className="card-pos-stat border-l-green-600">
                <div>
                  <p className="card-pos-stat-label">Estado</p>
                  <p className="text-2xl font-bold mt-2 text-green-600">
                    Abierta
                  </p>
                </div>
              </Card>
            </div>

            {/* Actions */}
            <div className="flex gap-4">
              <Button
                onClick={() => setShowMovementDialog(true)}
                className="btn-pos-primary gap-2"
              >
                <Plus size={20} />
                Registrar Movimiento
              </Button>
              <Button
                onClick={() => setShowCloseDialog(true)}
                className="btn-pos-danger gap-2"
              >
                Cerrar Caja
              </Button>
            </div>

            {/* Movements Table */}
            {movements.length > 0 && (
              <Card className="p-0 overflow-hidden">
                <table className="table-pos">
                  <thead>
                    <tr>
                      <th>Hora</th>
                      <th>Tipo</th>
                      <th>Usuario</th>
                      <th>Monto</th>
                      <th>Razón</th>
                    </tr>
                  </thead>
                  <tbody>
                    {movements.map((movement) => {
                      const amount = parseFloat(movement.amount);
                      const isCardSale = movement.reason.includes("Tarjeta");
                      return (
                        <tr key={movement.id}>
                          <td className="text-sm">
                            {new Date(movement.createdAt).toLocaleTimeString()}
                          </td>
                          <td>
                            <span
                              className={`badge-pos-${
                                movement.type === "IN" ? "active" : "pending"
                              }`}
                            >
                              {movement.type === "IN" ? "Ingreso" : "Retiro"}
                            </span>
                          </td>
                          <td className="text-sm">
                            {movement.userName || "N/A"}
                          </td>
                          <td
                            className={`font-semibold ${
                              isCardSale
                                ? "text-blue-600"
                                : movement.type === "IN"
                                ? "text-green-600"
                                : "text-red-600"
                            }`}
                          >
                            {isCardSale ? (
                              <span className="text-sm">Tarjeta</span>
                            ) : (
                              <>
                                {movement.type === "IN" ? "+" : "-"}$
                                {amount.toFixed(2)}
                              </>
                            )}
                          </td>
                          <td className="text-sm">{movement.reason}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Card>
            )}
          </div>
        )}

        {/* Dialogs */}
        <Dialog open={showOpenDialog} onOpenChange={setShowOpenDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Abrir Caja</DialogTitle>
              <DialogDescription>
                Registra el monto inicial de la caja
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <Input
                type="number"
                placeholder="Monto inicial"
                value={openingAmount}
                onChange={(e: any) => setOpeningAmount(e.target.value)}
                className="text-lg h-12"
              />
              <Button
                onClick={handleOpenCash}
                className="btn-pos-primary w-full"
              >
                Abrir Caja
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        <Dialog open={showMovementDialog} onOpenChange={setShowMovementDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Registrar Movimiento</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <Tabs
                value={movementType}
                onValueChange={(value: any) =>
                  setMovementType(value as "IN" | "OUT")
                }
              >
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="IN">Ingreso</TabsTrigger>
                  <TabsTrigger value="OUT">Retiro</TabsTrigger>
                </TabsList>
              </Tabs>
              <Input
                type="number"
                placeholder="Monto"
                value={movementAmount}
                onChange={(e: any) => setMovementAmount(e.target.value)}
                className="text-lg h-12"
              />
              <Input
                type="text"
                placeholder="Razón del movimiento"
                value={movementReason}
                onChange={(e: any) => setMovementReason(e.target.value)}
                className="text-lg h-12"
              />
              <Button
                onClick={handleAddMovement}
                className="btn-pos-primary w-full"
              >
                Registrar
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        <Dialog open={showCloseDialog} onOpenChange={setShowCloseDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Cerrar Caja</DialogTitle>
              <DialogDescription>
                Total esperado: ${currentAmount.toFixed(2)}. Ingresa el monto
                real contado.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <Input
                type="number"
                placeholder="Monto real contado"
                value={actualAmount}
                onChange={(e: any) => setActualAmount(e.target.value)}
                className="text-lg h-12"
              />
              {actualAmount && (
                <div
                  className={`p-3 rounded-lg ${
                    Math.abs(parseFloat(actualAmount) - currentAmount) > 0.01
                      ? "bg-red-50 text-red-700"
                      : "bg-green-50 text-green-700"
                  }`}
                >
                  <p className="text-sm font-semibold">
                    Diferencia: $
                    {(parseFloat(actualAmount) - currentAmount).toFixed(2)}
                  </p>
                </div>
              )}
              <Button
                onClick={handleCloseCash}
                className="btn-pos-primary w-full"
              >
                Cerrar Caja
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </POSLayout>
  );
}
