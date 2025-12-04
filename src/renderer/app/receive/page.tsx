import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { POSLayout } from "@/components/pos-layout";
import { Card } from "@/components/ui/card";

interface User {
  id: number;
  name: string;
  role: "admin" | "vendor";
}

export default function ReceivePage() {
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
        <h1 className="text-3xl font-bold mb-8">Recepción de Mercancía</h1>
        
        <Card className="p-8 text-center">
          <p className="text-muted-foreground">Módulo de recepción en desarrollo</p>
        </Card>
      </div>
    </POSLayout>
  );
}
