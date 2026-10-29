import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  ShoppingCart,
  Plus,
  RotateCcw,
  DollarSign,
  LogOut,
  Eye,
  BarChart3,
  Users,
} from "lucide-react";

interface User {
  id: number;
  name: string;
  role: "admin" | "vendor";
}

export function POSNavbar() {
  const location = useLocation();
  const pathname = location.pathname;
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    const userStr = sessionStorage.getItem("user");
    if (userStr) {
      setUser(JSON.parse(userStr));
    }
  }, []);

  const handleLogout = async () => {
    try {
      await window.api.auth.logout();
    } catch (error) {
      console.error("Logout error:", error);
    }
    sessionStorage.removeItem("user");
    sessionStorage.removeItem("cashBoxOpen");
    navigate("/");
  };

  const isActive = (path: string) => pathname === path;

  if (!user) return null;

  const vendorLinks = [
    { href: "/cash", icon: DollarSign, label: "Caja" },
    { href: "/sales", icon: ShoppingCart, label: "Vender" },
    { href: "/returns", icon: RotateCcw, label: "Devoluciones" },
    { href: "/stock", icon: Eye, label: "Ver Stock" },
  ];

  const adminLinks = [
    { href: "/cash", icon: DollarSign, label: "Caja" },
    { href: "/sales", icon: ShoppingCart, label: "Vender" },
    { href: "/receive", icon: Plus, label: "Inventario" },
    { href: "/returns", icon: RotateCcw, label: "Devoluciones" },
    { href: "/stock", icon: Eye, label: "Ver Stock" },
    { href: "/dashboard", icon: BarChart3, label: "Dashboard" },
    { href: "/users", icon: Users, label: "Usuarios" },
  ];

  const links = user.role === "admin" ? adminLinks : vendorLinks;

  return (
    <nav className="bg-primary text-primary-foreground border-b border-primary/20 sticky top-0 z-40">
      <div className="flex items-center justify-between px-6 py-3 overflow-x-auto">
        <div className="flex items-center gap-2 flex-shrink-0">
          <h1 className="text-xl font-bold">POS Estética</h1>
          <span className="text-sm opacity-80">• {user.name}</span>
        </div>

        <div className="flex gap-1 overflow-x-auto">
          {links.map((link) => {
            const IconComponent = link.icon;
            return (
              <Link key={link.href} to={link.href}>
                <Button
                  variant={isActive(link.href) ? "secondary" : "ghost"}
                  size="sm"
                  className="gap-2 whitespace-nowrap"
                >
                  <IconComponent size={18} />
                  {link.label}
                </Button>
              </Link>
            );
          })}
          <Button
            onClick={handleLogout}
            variant="ghost"
            size="sm"
            className="gap-2 ml-2 border-l border-primary/20 pl-4 whitespace-nowrap"
          >
            <LogOut size={18} />
            Salir
          </Button>
        </div>
      </div>
    </nav>
  );
}
