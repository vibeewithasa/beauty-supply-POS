import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Banknote, CreditCard, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export type RefundMethod = "cash" | "card";

export const money = (v: string | number) => `$${(Math.round(Number(v) * 100) / 100).toFixed(2)}`;

/** The four states a refund can be in, as the owner reads them. `paymentMethod` only exists once the money was handed back. */
export function refundBadge(r: { refundStatus: string; paymentMethod?: string | null }): { key: "pending" | "cash" | "card" | "legacy"; label: string; className: string } {
  if (r.refundStatus === "paid" && r.paymentMethod === "cash") return { key: "cash", label: "PAGADO EN EFECTIVO", className: "text-green-700 font-semibold" };
  if (r.refundStatus === "paid" && r.paymentMethod === "card") return { key: "card", label: "PAGADO POR TARJETA", className: "text-blue-700 font-semibold" };
  if (r.refundStatus === "pending") return { key: "pending", label: "PENDIENTE", className: "text-amber-700 font-semibold" };
  return { key: "legacy", label: "LEGACY (anterior al control)", className: "text-muted-foreground" };
}

/**
 * How the money was handed back, plus the explicit confirmation that it ALREADY was. Nothing is ever recorded as paid
 * without the checkbox: the sentence says what the operator is vouching for.
 */
export function PaymentFields({
  amount,
  method,
  onMethod,
  confirmed,
  onConfirmed,
  reference,
  onReference,
  idPrefix,
}: {
  amount: string;
  method: RefundMethod | "";
  onMethod: (m: RefundMethod) => void;
  confirmed: boolean;
  onConfirmed: (c: boolean) => void;
  reference: string;
  onReference: (r: string) => void;
  idPrefix: string;
}) {
  const btn = (m: RefundMethod, label: string, icon: ReactNode) => (
    <button
      type="button"
      id={`${idPrefix}-method-${m}`}
      aria-pressed={method === m}
      onClick={() => onMethod(m)}
      className={`flex-1 h-14 rounded-lg border-2 flex items-center justify-center gap-2 font-semibold ${method === m ? "border-primary bg-primary/10 text-primary" : "border-border bg-background"}`}
    >
      {icon}
      {label}
    </button>
  );
  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-semibold mb-1">¿Cómo se le reembolsó al cliente?</p>
        <div className="flex gap-3" role="group" aria-label="Forma del reembolso">
          {btn("cash", "Efectivo desde caja", <Banknote size={20} />)}
          {btn("card", "Tarjeta", <CreditCard size={20} />)}
        </div>
      </div>
      {method === "card" && (
        <div>
          <label htmlFor={`${idPrefix}-reference`} className="text-sm font-semibold block mb-1">
            Referencia de la terminal <span className="font-normal text-muted-foreground">(opcional)</span>
          </label>
          <Input id={`${idPrefix}-reference`} value={reference} maxLength={64} onChange={(e) => onReference(e.target.value)} className="h-10" />
          <p className="text-xs text-muted-foreground mt-1">El reembolso con tarjeta se hace en la terminal bancaria; este sistema no ejecuta operaciones bancarias ni toca el efectivo de la caja.</p>
        </div>
      )}
      {method !== "" && (
        <label htmlFor={`${idPrefix}-confirm`} className="flex items-start gap-3 rounded border border-amber-400 bg-amber-50 p-3 cursor-pointer">
          <input id={`${idPrefix}-confirm`} type="checkbox" checked={confirmed} onChange={(e) => onConfirmed(e.target.checked)} className="mt-1 h-5 w-5" />
          <span className="text-sm">
            {method === "cash" ? (
              <>Confirmo que <strong>ya entregué {money(amount)} en efectivo</strong> al cliente (saldrá de la caja al registrar).</>
            ) : (
              <>Confirmo que el reembolso de <strong>{money(amount)}</strong> <strong>ya se realizó en la terminal de tarjeta</strong>.</>
            )}
          </span>
        </label>
      )}
    </div>
  );
}

/**
 * Asks for an administrator's PIN to authorize ONE operation. The PIN lives only in this component's state while it is typed and is
 * cleared the moment it is submitted: it is never kept, shown again or sent anywhere but the call that authorizes the operation.
 * The operator's own session is not involved (the dialog never signs anybody in).
 */
export function AuthorizationDialog({
  open,
  title,
  description,
  children,
  submitLabel,
  busy,
  error,
  warning,
  canSubmit = true,
  onSubmit,
  onCancel,
  onVerify,
}: {
  open: boolean;
  title: string;
  description: string;
  children?: ReactNode;
  submitLabel: string;
  busy: boolean;
  error: string;
  /** shown when the outcome of the last attempt is UNKNOWN (the money may already have been handed over) */
  warning: string;
  canSubmit?: boolean;
  onSubmit: (pin: string) => void | Promise<void>;
  onCancel: () => void;
  /** closes the dialog so the operator can check the history before trying again */
  onVerify: () => void;
}) {
  const [pin, setPin] = useState("");
  useEffect(() => {
    if (open) {
      setPin("");
      const t = setTimeout(() => document.getElementById("rf-admin-pin")?.focus(), 80);
      return () => clearTimeout(t);
    }
    setPin("");
  }, [open]);

  const submit = () => {
    if (busy || !canSubmit || pin.length < 4) return;
    const typed = pin;
    setPin(""); // the PIN is not kept after it was handed over
    void onSubmit(typed);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onCancel()}>
      <DialogContent className="max-w-lg" onPointerDownOutside={(e) => e.preventDefault()} onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><ShieldCheck size={20} /> {title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        {warning && (
          <p role="alert" data-testid="rf-uncertain" className="text-sm rounded border border-red-400 bg-red-50 text-red-900 p-3">
            {warning}
          </p>
        )}
        <div>
          <label htmlFor="rf-admin-pin" className="text-sm font-semibold block mb-1">PIN de administrador</label>
          <Input
            id="rf-admin-pin"
            type="password"
            name="authorization-code"
            autoComplete="off"
            inputMode="numeric"
            maxLength={8}
            value={pin}
            disabled={busy}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            className="h-12 text-center text-2xl tracking-widest"
          />
          <p className="text-xs text-muted-foreground mt-1">Solo autoriza esta operación. No cambia la sesión de quien atiende.</p>
          {error && <p role="alert" data-testid="rf-auth-error" className="text-sm text-red-600 mt-2">{error}</p>}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button variant="outline" className="flex-1 h-11" disabled={busy} onClick={onCancel}>Cancelar</Button>
          {warning && <Button variant="outline" className="flex-1 h-11" disabled={busy} onClick={onVerify}>Verificar en el historial</Button>}
          <Button className="btn-pos-success flex-1 h-11" disabled={busy || !canSubmit || pin.length < 4} onClick={submit}>
            {busy ? "Registrando..." : submitLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
