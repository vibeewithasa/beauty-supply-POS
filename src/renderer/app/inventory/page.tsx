import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { POSLayout } from "@/components/pos-layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface User {
  id: number;
  name: string;
  role: "admin" | "vendor";
}

export default function InventoryPage() {
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
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold">Gestión de Inventario</h1>
          <Button className="btn-pos-primary">+ Nuevo Producto</Button>
        </div>
        
        <Card className="p-8 text-center">
          <p className="text-muted-foreground">Módulo de inventario en desarrollo</p>
          <p className="text-sm mt-2">Usa el módulo de "Ver Stock" para consultar productos</p>
        </Card>
      </div>
    </POSLayout>
  );
}
