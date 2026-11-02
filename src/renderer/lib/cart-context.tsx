// The sales cart lives above the routes so that visiting another module does not discard it. It is memory only: it is
// never written to disk, it holds no PIN or session data, and it belongs to ONE login session (see bindOwner / reset).
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { CartItem } from "./cart";

export interface CompletedSale {
  id: number;
  total: string;
  paymentMethod: "cash" | "card";
  createdAt: Date | string;
  itemCount: number | null;
}

interface CartApi {
  items: CartItem[];
  setItems: (update: CartItem[] | ((prev: CartItem[]) => CartItem[])) => void;
  /** A sale registered and not yet acknowledged: it survives leaving the screen while the payment was in flight. */
  completed: CompletedSale | null;
  setCompleted: (sale: CompletedSale | null) => void;
  /** A payment request is in flight (or has an unknown outcome being awaited). */
  paying: boolean;
  /** Starts a payment. Returns a token, or null if one is already running. The token goes stale when the session changes. */
  beginPayment: () => number | null;
  endPayment: (token: number) => void;
  isCurrent: (token: number) => boolean;
  /** Operation id of this exact checkout: asking again with the same signature returns the same id, so a retry cannot charge twice. */
  operationFor: (signature: string) => string;
  /** The sale was registered or definitively rejected: the next attempt, even of the same cart, is a new operation. */
  releaseOperation: () => void;
  /** Called by the protected routes with the authenticated user (null = no session). A different identity gets an empty cart. */
  bindOwner: (userId: number | null) => void;
  /** Login, logout or an expired session: the cart of the previous session is dropped. */
  reset: () => void;
}

const newOperationId = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `op-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`);

const CartContext = createContext<CartApi | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<CartItem[]>([]);
  const [completed, setCompleted] = useState<CompletedSale | null>(null);
  const [paying, setPaying] = useState(false);
  const owner = useRef<number | null>(null);
  const epoch = useRef(0); // bumps on every reset: results of a payment started by a previous session are ignored
  const payingRef = useRef(false); // synchronous guard: state updates are too late to stop a double click
  const operation = useRef<{ signature: string; id: string } | null>(null);

  const reset = useCallback(() => {
    epoch.current += 1;
    owner.current = null;
    payingRef.current = false;
    operation.current = null;
    setItems([]);
    setCompleted(null);
    setPaying(false);
  }, []);

  const bindOwner = useCallback(
    (userId: number | null) => {
      if (owner.current === userId) return;
      reset();
      owner.current = userId;
    },
    [reset]
  );

  const beginPayment = useCallback(() => {
    if (payingRef.current) return null;
    payingRef.current = true;
    setPaying(true);
    return epoch.current;
  }, []);

  const endPayment = useCallback((token: number) => {
    if (token !== epoch.current) return;
    payingRef.current = false;
    setPaying(false);
  }, []);

  const isCurrent = useCallback((token: number) => token === epoch.current, []);

  const operationFor = useCallback((signature: string) => {
    if (operation.current?.signature !== signature) operation.current = { signature, id: newOperationId() };
    return operation.current.id;
  }, []);

  const releaseOperation = useCallback(() => {
    operation.current = null;
  }, []);

  const value = useMemo<CartApi>(
    () => ({ items, setItems, completed, setCompleted, paying, beginPayment, endPayment, isCurrent, operationFor, releaseOperation, bindOwner, reset }),
    [items, completed, paying, beginPayment, endPayment, isCurrent, operationFor, releaseOperation, bindOwner, reset]
  );
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartApi {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used inside <CartProvider>");
  return ctx;
}
