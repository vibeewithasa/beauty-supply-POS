"use client";

import Link from "next/link";
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from "./ui/button";
import { Home, ShoppingCart, Package, DollarSign, RotateCcw, FileText, Settings, LogOut, Plus } from 'lucide-react';

interface User {
  id: number;
  name: string;
  role: "admin" | "vendor";
}

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    const userStr = sessionStorage.getItem("user");
    if (userStr) {
      setUser(JSON.parse(userStr));
    }
  }, []);

  const isActive = (path: string) => pathname === path;

  const handleLogout = () => {
    sessionStorage.removeItem("user");
    router.push("/");
  };

  const adminNavItems = [
    { href: "/dashboard", label: "Dashboard", icon: Home },
    { href: "/reports", label: "Reportes", icon: FileText },
    { href: "/users", label: "Usuarios", icon: Settings },
  ];

  const vendorNavItems = [
    { href: "/sales", label: "Vender", icon: ShoppingCart },
    { href: "/receive", label: "Recibir Inventario", icon: Plus },
    { href: "/returns", label: "Devoluciones", icon: RotateCcw },
    { href: "/cash", label: "Caja", icon: DollarSign },
  ];

  const navItems = user?.role === "admin" ? adminNavItems : vendorNavItems;

  return (
    <aside className="w-64 bg-sidebar border-r border-sidebar-border flex flex-col">
      {/* Header */}
      <div className="p-6 border-b border-sidebar-border">
        <h1 className="text-lg font-bold text-sidebar-primary">POS Estética</h1>
        <p className="text-xs text-sidebar-foreground/60 mt-1">
          {user?.name} • {user?.role === "admin" ? "Administrador" : "Vendedora"}
        </p>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-4 space-y-2">
        {navItems.map(({ href, label, icon: Icon }) => (
          <Link key={href} href={href}>
            <Button
              variant="ghost"
              className={`w-full justify-start gap-3 ${
                isActive(href)
                  ? "bg-sidebar-primary text-sidebar-primary-foreground"
                  : "text-sidebar-foreground hover:bg-sidebar-accent"
              }`}
            >
              <Icon size={20} />
              {label}
            </Button>
          </Link>
        ))}
      </nav>

      {/* Footer */}
      <div className="p-4 border-t border-sidebar-border">
        <Button 
          onClick={handleLogout}
          variant="ghost" 
          className="w-full justify-start gap-3 text-sidebar-foreground hover:bg-sidebar-accent"
        >
          <LogOut size={20} />
          Cerrar Sesión
        </Button>
      </div>
    </aside>
  );
}
