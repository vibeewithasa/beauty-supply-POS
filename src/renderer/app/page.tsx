import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import { describeIpcError } from "@/lib/ipc-error";

// 4-digit PINs of existing accounts still work; new PINs have 6 to 8 digits (enforced by the backend).
const MIN_PIN = 4;
const MAX_PIN = 8;

export default function LoginPage() {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handlePinInput = (digit: string) => {
    if (pin.length < MAX_PIN) {
      setPin(pin + digit);
      setError("");
    }
  };

  const handleBackspace = () => {
    setPin(pin.slice(0, -1));
    setError("");
  };

  const handleLogin = async () => {
    if (pin.length < MIN_PIN) {
      setError("Ingresa tu PIN (mínimo 4 dígitos)");
      return;
    }

    try {
      setLoading(true);
      setError("");
      const user = await window.api.auth.login(pin);

      if (user) {
        sessionStorage.setItem("user", JSON.stringify(user));
        toast.success(`Bienvenido ${user.name}`);
        navigate(user.role === "admin" ? "/dashboard" : "/sales");
      } else {
        setError("PIN incorrecto");
        setPin("");
      }
    } catch (err) {
      console.error("Login error:", err);
      // the only specific message is the lock after too many failed attempts (generic about users)
      const { code, message } = describeIpcError(err, "Error al iniciar sesión");
      const text = code === "LOGIN_BLOQUEADO" ? message : "Error al iniciar sesión";
      setError(text);
      setPin("");
      toast.error(text);
    } finally {
      setLoading(false);
    }
  };

  const handleClear = () => {
    setPin("");
    setError("");
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary to-primary/80 flex items-center justify-center p-4">
      <Card className="w-full max-w-md shadow-2xl">
        <div className="p-8">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-primary mb-2">
              POS Estética
            </h1>
            <p className="text-muted-foreground">
              Ingresa tu PIN para comenzar
            </p>
          </div>

          <div className="mb-6">
            <div className="bg-muted rounded-lg p-4 text-center mb-4">
              <div className="text-4xl tracking-widest font-mono font-bold text-primary">
                {"•".repeat(pin.length)}
                {pin.length < MIN_PIN ? "○".repeat(MIN_PIN - pin.length) : ""}
              </div>
            </div>
            {error && (
              <div className="text-center text-red-600 text-sm font-medium">
                {error}
              </div>
            )}
          </div>

          <div className="grid grid-cols-3 gap-3 mb-6">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((num) => (
              <button
                key={num}
                onClick={() => handlePinInput(num.toString())}
                className="btn-pos-primary text-2xl h-16 rounded-lg font-bold"
              >
                {num}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-3 gap-3 mb-6">
            <button
              onClick={handleClear}
              className="btn-pos-secondary rounded-lg text-lg font-bold"
            >
              Limpiar
            </button>
            <button
              onClick={() => handlePinInput("0")}
              className="btn-pos-primary col-span-1 text-2xl h-14 rounded-lg font-bold"
            >
              0
            </button>
            <button
              onClick={handleBackspace}
              disabled={pin.length === 0}
              className="btn-pos-secondary rounded-lg text-lg font-bold disabled:opacity-50"
            >
              ← Atrás
            </button>
          </div>

          <Button
            onClick={handleLogin}
            disabled={pin.length < MIN_PIN || loading}
            className="w-full btn-pos-primary h-14 text-lg font-bold disabled:opacity-50"
          >
            {loading ? "Ingresando..." : "Iniciar Sesión"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
