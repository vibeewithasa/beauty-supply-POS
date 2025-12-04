import { ReactNode } from "react";
import { POSNavbar } from "./pos-navbar";

interface POSLayoutProps {
  children: ReactNode;
}

export function POSLayout({ children }: POSLayoutProps) {
  return (
    <div className="flex flex-col h-screen bg-background">
      <POSNavbar />
      <main className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-auto">{children}</div>
      </main>
    </div>
  );
}
