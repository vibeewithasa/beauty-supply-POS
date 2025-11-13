import React, { useEffect, useMemo, useRef, useState } from "react";

type User = {
  id: number;
  name: string;
  role: "admin" | "vendor";
};

declare global {
  interface Window {
    api: {
      auth: { login(pin: string): Promise<User | null> };
      products: { findBySkuOrBarcode(q: string): Promise<any | null> };
    };
  }
}

function useBarcodeInput(onCode: (code: string) => void) {
  const buffer = useRef<string>("");
  const lastTime = useRef<number>(0);
  const timeout = useRef<any>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const now = Date.now();
      const delta = now - lastTime.current;
      lastTime.current = now;

      if (timeout.current) clearTimeout(timeout.current);
      timeout.current = setTimeout(() => {
        buffer.current = "";
      }, 50);

      if (e.key === "Enter") {
        if (buffer.current.length > 3) {
          onCode(buffer.current);
        }
        buffer.current = "";
        return;
      }
      if (delta < 30) {
        buffer.current += e.key;
      } else {
        buffer.current = e.key;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCode]);
}

const Login: React.FC<{ onLogged: (u: User) => void }> = ({ onLogged }) => {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="bg-white p-6 rounded shadow w-80">
        <h1 className="text-xl font-semibold mb-4">Acceso por PIN</h1>
        <input
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          onKeyDown={async (e) => {
            if (e.key === "Enter") {
              setError(null);
              const user = await window.api.auth.login(pin);
              if (user) onLogged(user);
              else setError("PIN inválido");
            }
          }}
          type="password"
          className="w-full border rounded p-2 mb-2"
          placeholder="PIN"
        />
        {error && <div className="text-red-600 text-sm mb-2">{error}</div>}
        <button
          onClick={async () => {
            setError(null);
            const user = await window.api.auth.login(pin);
            if (user) onLogged(user);
            else setError("PIN inválido");
          }}
          className="w-full bg-blue-600 text-white py-2 rounded"
        >
          Entrar
        </button>
      </div>
    </div>
  );
};

const SalesScreen: React.FC<{ user: User }> = ({ user }) => {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<any | null>(null);

  useBarcodeInput(async (code) => {
    const p = await window.api.products.findBySkuOrBarcode(code);
    setFound(p);
  });

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="text-lg">
          Usuario: {user.name} ({user.role})
        </div>
        <div className="font-semibold">Beauty POS</div>
      </div>
      <div className="flex gap-2 mb-2">
        <input
          className="border rounded p-2 flex-1"
          placeholder="SKU o código de barras"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={async (e) => {
            if (e.key === "Enter") {
              const p = await window.api.products.findBySkuOrBarcode(query);
              setFound(p);
            }
          }}
        />
        <button
          className="bg-gray-800 text-white px-4 rounded"
          onClick={async () => {
            const p = await window.api.products.findBySkuOrBarcode(query);
            setFound(p);
          }}
        >
          Buscar
        </button>
      </div>
      <div className="border rounded p-3 bg-white">
        {found ? (
          <pre className="text-sm whitespace-pre-wrap">
            {JSON.stringify(found, null, 2)}
          </pre>
        ) : (
          <div className="text-gray-500">
            Escanea un código o escribe y presiona Enter…
          </div>
        )}
      </div>
    </div>
  );
};

const App: React.FC = () => {
  const [user, setUser] = useState<User | null>(null);
  if (!user) return <Login onLogged={setUser} />;
  return <SalesScreen user={user} />;
};

export default App;
