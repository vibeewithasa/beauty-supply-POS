import { Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import LoginPage from "./app/page";
import DashboardPage from "./app/dashboard/page";
import SalesPage from "./app/sales/page";
import CashPage from "./app/cash/page";
import InventoryPage from "./app/inventory/page";
import ReturnsPage from "./app/returns/page";
import ReportsPage from "./app/reports/page";
import UsersPage from "./app/users/page";
import StockPage from "./app/stock/page";
import ReceivePage from "./app/receive/page";
import HistoryPage from "./app/history/page";
import CashHistoryPage from "./app/cash-history/page";
import SettingsPage from "./app/settings/page";

interface User {
  id: number;
  name: string;
  role: "admin" | "vendor";
}

// Protected Route Component
function ProtectedRoute({
  children,
  requiredRole,
}: {
  children: React.ReactNode;
  requiredRole?: "admin" | "vendor";
}) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const { pathname } = useLocation();

  // The main process is the authority: sessionStorage is only a UI cache. It is asked on every
  // navigation because Routes reuses this component instance between routes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    window.api.auth
      .me()
      .then((me) => {
        if (cancelled) return;
        if (me) {
          sessionStorage.setItem("user", JSON.stringify(me));
        } else {
          sessionStorage.removeItem("user");
        }
        setUser(me);
      })
      .catch(() => {
        // me() failed for a reason other than "no session" (e.g. database/IPC error): do not log the
        // user out. Keep the cached identity for display; the main process still enforces every call.
        if (cancelled) return;
        const cached = sessionStorage.getItem("user");
        setUser(cached ? JSON.parse(cached) : null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/" replace />;
  }

  if (requiredRole === "admin" && user.role !== "admin") {
    return <Navigate to="/sales" replace />;
  }

  return <>{children}</>;
}

// Sends the user to the login when the main process reports a lost/revoked session
// (event raised by the preload only for "Sesión no válida", never for role or other errors).
function SessionWatcher() {
  const navigate = useNavigate();
  useEffect(() => {
    const onExpired = () => {
      sessionStorage.removeItem("user");
      navigate("/", { replace: true });
    };
    window.addEventListener("pos:session-expired", onExpired);
    return () => window.removeEventListener("pos:session-expired", onExpired);
  }, [navigate]);
  return null;
}

function App() {
  return (
    <>
      <SessionWatcher />
      <Routes>
      <Route path="/" element={<LoginPage />} />

      {/* Admin only routes */}
      <Route
        path="/dashboard"
        element={
          <ProtectedRoute requiredRole="admin">
            <DashboardPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/inventory"
        element={
          <ProtectedRoute requiredRole="admin">
            <InventoryPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/receive"
        element={
          <ProtectedRoute requiredRole="admin">
            <ReceivePage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/reports"
        element={
          <ProtectedRoute requiredRole="admin">
            <ReportsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings"
        element={
          <ProtectedRoute requiredRole="admin">
            <SettingsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/users"
        element={
          <ProtectedRoute requiredRole="admin">
            <UsersPage />
          </ProtectedRoute>
        }
      />

      {/* Both admin and vendor routes */}
      <Route
        path="/sales"
        element={
          <ProtectedRoute>
            <SalesPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/cash"
        element={
          <ProtectedRoute>
            <CashPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/history"
        element={
          <ProtectedRoute>
            <HistoryPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/cash/history"
        element={
          <ProtectedRoute>
            <CashHistoryPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/returns"
        element={
          <ProtectedRoute>
            <ReturnsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/stock"
        element={
          <ProtectedRoute>
            <StockPage />
          </ProtectedRoute>
        }
      />

      {/* Fallback */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </>
  );
}

export default App;
