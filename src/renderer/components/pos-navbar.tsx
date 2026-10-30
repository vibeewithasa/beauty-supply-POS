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
  Package,
  FileText,
  Receipt,
  Settings,
} from "lucide-react";

interface User {
  id: number;
  name: string;
  role: "admin" | "vendor";
}

type NavLink = { href: string; icon: typeof DollarSign; label: string };
type NavGroup = { title: string; links: NavLink[] };

// Same destinations as before, grouped by what people are doing: selling, stock, and running the shop.
const OPERATION: NavGroup = {
  title: "Operación",
  links: [
    { href: "/sales", icon: ShoppingCart, label: "Vender" },
    { href: "/cash", icon: DollarSign, label: "Caja" },
    { href: "/history", icon: Receipt, label: "Historial" },
    { href: "/returns", icon: RotateCcw, label: "Devoluciones" },
  ],
};
const VENDOR_GROUPS: NavGroup[] = [{ ...OPERATION, links: [...OPERATION.links, { href: "/stock", icon: Eye, label: "Ver Stock" }] }];
const ADMIN_GROUPS: NavGroup[] = [
  OPERATION,
  {
    title: "Inventario",
    links: [
      { href: "/inventory", icon: Package, label: "Productos" },
      { href: "/receive", icon: Plus, label: "Recepción" },
      { href: "/stock", icon: Eye, label: "Ver Stock" },
    ],
  },
  {
    title: "Gestión",
    links: [
      { href: "/dashboard", icon: BarChart3, label: "Dashboard" },
      { href: "/reports", icon: FileText, label: "Reportes" },
      { href: "/users", icon: Users, label: "Usuarios" },
      { href: "/settings", icon: Settings, label: "Configuración" },
    ],
  },
];

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

  const groups = user.role === "admin" ? ADMIN_GROUPS : VENDOR_GROUPS;

  return (
    <nav aria-label="Navegación principal" className="bg-primary text-primary-foreground border-b border-primary/20 sticky top-0 z-40">
      <div className="flex items-center justify-between gap-3 px-4 pt-2">
        <div className="flex items-baseline gap-2 min-w-0">
          <h1 className="text-lg font-bold whitespace-nowrap">POS Estética</h1>
          <span className="text-sm opacity-80 truncate">• {user.name}</span>
        </div>
        <Button onClick={handleLogout} variant="ghost" size="sm" className="gap-2 h-10 whitespace-nowrap flex-shrink-0">
          <LogOut size={18} />
          Salir
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pb-2">
        {groups.map((group) => (
          <div key={group.title} role="group" aria-label={group.title} className="flex items-center gap-1 [&:not(:first-child)]:border-l [&:not(:first-child)]:border-primary-foreground/25 [&:not(:first-child)]:pl-3">
            {groups.length > 1 && <span className="text-[10px] uppercase tracking-wide opacity-60 px-1 hidden 2xl:inline">{group.title}</span>}
            {group.links.map((link) => {
              const IconComponent = link.icon;
              return (
                <Link key={link.href} to={link.href} aria-current={isActive(link.href) ? "page" : undefined}>
                  <Button variant={isActive(link.href) ? "secondary" : "ghost"} size="sm" className="gap-1.5 h-10 px-2.5 whitespace-nowrap">
                    <IconComponent size={18} className="hidden xl:block" />
                    {link.label}
                  </Button>
                </Link>
              );
            })}
          </div>
        ))}
      </div>
    </nav>
  );
}
