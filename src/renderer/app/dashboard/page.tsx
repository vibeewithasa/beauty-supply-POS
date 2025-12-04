import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { POSLayout } from "@/components/pos-layout";
import { Card } from "@/components/ui/card";
import { BarChart3, Package, DollarSign, Users } from "lucide-react";

interface User {
  id: number;
  name: string;
  role: "admin" | "vendor";
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>(null);

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
  }, [navigate]);

  if (!user) return null;

  return (
    <POSLayout>
      <div className="p-8">
        <h1 className="text-3xl font-bold mb-8">Dashboard Administrativo</h1>
        
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          <Card className="card-pos-stat">
            <div className="flex items-center justify-between">
              <div>
                <p className="card-pos-stat-label">Ventas Hoy</p>
                <p className="card-pos-stat-value mt-2">$0.00</p>
              </div>
              <DollarSign className="text-primary" size={40} />
            </div>
          </Card>

          <Card className="card-pos-stat">
            <div className="flex items-center justify-between">
              <div>
                <p className="card-pos-stat-label">Productos</p>
                <p className="card-pos-stat-value mt-2">0</p>
              </div>
              <Package className="text-primary" size={40} />
            </div>
          </Card>

          <Card className="card-pos-stat">
            <div className="flex items-center justify-between">
              <div>
                <p className="card-pos-stat-label">Usuarios</p>
                <p className="card-pos-stat-value mt-2">0</p>
              </div>
              <Users className="text-primary" size={40} />
            </div>
          </Card>

          <Card className="card-pos-stat">
            <div className="flex items-center justify-between">
              <div>
                <p className="card-pos-stat-label">Stock Bajo</p>
                <p className="card-pos-stat-value mt-2">0</p>
              </div>
              <BarChart3 className="text-yellow-600" size={40} />
            </div>
          </Card>
        </div>

        <Card className="p-6">
          <h2 className="text-xl font-bold mb-4">Dashboard en Desarrollo</h2>
          <p className="text-muted-foreground">
            Aquí se mostrarán gráficos y reportes detallados del sistema.
          </p>
        </Card>
      </div>
    </POSLayout>
  );
}
