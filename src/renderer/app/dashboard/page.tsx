import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { POSLayout } from "@/components/pos-layout";
import { StatCard } from "@/components/stat-card";
import { Card } from "@/components/ui/card";
import {
  ShoppingCart,
  DollarSign,
  RotateCcw,
  Package,
  TrendingUp,
  Users,
  AlertCircle,
  Calendar,
} from "lucide-react";
import { toast } from "sonner";

interface User {
  id: number;
  name: string;
  role: "admin" | "vendor";
}

interface DashboardStats {
  todaySales: {
    total: string;
    count: number;
  };
  paymentMethods: Array<{
    method: "cash" | "card";
    total: string;
  }>;
  products: {
    total: number;
    lowStock: number;
  };
  users: {
    total: number;
  };
  returns: {
    total: string;
    count: number;
    pending: { total: string; count: number };
    paid: { total: string; count: number };
    legacy: { total: string; count: number };
  };
  stock: {
    total: number;
  };
  cashSession: any;
  lastSale: string;
  weekSales: {
    total: string;
  };
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>(null);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const userStr = sessionStorage.getItem("user");
    if (!userStr) {
      navigate("/");
      return;
    }
    const parsedUser = JSON.parse(userStr);
    if (parsedUser.role !== "admin") {
      navigate("/sales");
      return;
    }
    setUser(parsedUser);
    loadStats();
  }, [navigate]);

  const loadStats = async () => {
    try {
      const data = await window.api.dashboard.getStats();
      setStats(data);
    } catch (error) {
      console.error("Error loading stats:", error);
      toast.error("Error al cargar estadísticas");
    } finally {
      setLoading(false);
    }
  };

  if (!user || loading) return null;

  const todaySalesTotal = stats ? parseFloat(stats.todaySales.total) : 0;
  const weekSalesTotal = stats ? parseFloat(stats.weekSales.total) : 0;
  // a registered return is not money handed back: pending refunds are shown apart from paid ones
  const refundsPending = stats ? parseFloat(stats.returns.pending.total) : 0;
  const refundsPaid = stats ? parseFloat(stats.returns.paid.total) : 0;

  const cashTotal =
    stats?.paymentMethods.find((pm) => pm.method === "cash")?.total || "0";
  const cardTotal =
    stats?.paymentMethods.find((pm) => pm.method === "card")?.total || "0";

  const cashPercent =
    todaySalesTotal > 0
      ? ((parseFloat(cashTotal) / todaySalesTotal) * 100).toFixed(1)
      : "0";
  const cardPercent =
    todaySalesTotal > 0
      ? ((parseFloat(cardTotal) / todaySalesTotal) * 100).toFixed(1)
      : "0";

  const avgTicket =
    stats && stats.todaySales.count > 0
      ? (todaySalesTotal / stats.todaySales.count).toFixed(2)
      : "0.00";

  return (
    <POSLayout>
      <div className="p-4 md:p-6">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl md:text-3xl font-bold text-foreground mb-2">
            Dashboard Administrativo
          </h1>
          <p className="text-muted-foreground">
            Bienvenido, {user.name} - Resumen de operaciones del día
          </p>
        </div>

        {/* Row 1 - Métricas principales */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          <StatCard
            label="Ventas Hoy"
            value={`$${todaySalesTotal.toFixed(2)}`}
            icon={<ShoppingCart />}
            variant="success"
          />
          <StatCard
            label={stats?.cashSession ? "Caja Abierta" : "Caja Cerrada"}
            value={
              stats?.cashSession
                ? `$${parseFloat(stats.cashSession.currentAmount).toFixed(2)}`
                : "$0.00"
            }
            icon={<DollarSign />}
            variant={stats?.cashSession ? "default" : "warning"}
          />
          <StatCard
            label="Reembolsos pendientes de pago (hoy)"
            value={`$${refundsPending.toFixed(2)}`}
            icon={<RotateCcw />}
            variant={refundsPending > 0 ? "warning" : "default"}
          />
          <StatCard
            label="Reembolsos pagados (hoy)"
            value={`$${refundsPaid.toFixed(2)}`}
            icon={<RotateCcw />}
            variant="default"
          />
          <StatCard
            label="Stock Total"
            value={stats?.stock.total || 0}
            icon={<Package />}
            variant="default"
          />
        </div>

        {/* Row 2 - Métricas adicionales */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          <StatCard
            label="Ingresos Semana"
            value={`$${weekSalesTotal.toFixed(2)}`}
            icon={<TrendingUp />}
            variant="success"
          />
          <StatCard
            label="Productos Bajo Stock"
            value={stats?.products.lowStock || 0}
            icon={<AlertCircle />}
            variant={
              (stats?.products.lowStock || 0) > 0 ? "warning" : "default"
            }
          />
          <StatCard
            label="Usuarios Activos"
            value={stats?.users.total || 0}
            icon={<Users />}
            variant="default"
          />
          <StatCard
            label="Transacciones Hoy"
            value={stats?.todaySales.count || 0}
            icon={<ShoppingCart />}
            variant="default"
          />
        </div>

        {/* Row 3 - Promedios */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
          <Card className="p-6">
            <div className="flex items-start justify-between mb-4">
              <div>
                <p className="text-sm text-muted-foreground mb-1">
                  Ticket Promedio
                </p>
                <p className="text-3xl font-bold">${avgTicket}</p>
              </div>
              <DollarSign className="text-primary" size={32} />
            </div>
            <div className="text-xs text-muted-foreground">
              Basado en {stats?.todaySales.count || 0} transacciones
            </div>
          </Card>

          <Card className="p-6">
            <div className="flex items-start justify-between mb-4">
              <div>
                <p className="text-sm text-muted-foreground mb-1">
                  Total de Productos
                </p>
                <p className="text-3xl font-bold">
                  {stats?.products.total || 0}
                </p>
              </div>
              <Package className="text-primary" size={32} />
            </div>
            <div className="text-xs text-muted-foreground">
              Productos activos en catálogo
            </div>
          </Card>
        </div>

        {/* Row 4 - Métodos de pago */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Card className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Efectivo</p>
                <p className="text-2xl font-bold">
                  ${parseFloat(cashTotal).toFixed(2)}
                </p>
              </div>
              <div className="text-right text-sm text-muted-foreground">
                {cashPercent}%
              </div>
            </div>
          </Card>

          <Card className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Tarjeta</p>
                <p className="text-2xl font-bold">
                  ${parseFloat(cardTotal).toFixed(2)}
                </p>
              </div>
              <div className="text-right text-sm text-muted-foreground">
                {cardPercent}%
              </div>
            </div>
          </Card>

          <Card className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Última Venta</p>
                <p className="text-2xl font-bold">{stats?.lastSale || "N/A"}</p>
              </div>
              <Calendar className="text-primary" size={32} />
            </div>
          </Card>
        </div>
      </div>
    </POSLayout>
  );
}
