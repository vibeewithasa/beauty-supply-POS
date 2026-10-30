import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Printer } from "lucide-react";
import { describeIpcError } from "@/lib/ipc-error";

type PrintStatus = { kind: "idle" | "printing" | "printed" | "cancelled" | "failed"; message: string };

/**
 * Receipt preview and printing for a persisted sale. The renderer only sends the sale id: the document is built in
 * the main process from PostgreSQL. The preview is a script-less sandboxed iframe, and printing never touches the sale.
 */
export function ReceiptDialog({
  saleId,
  copy = false,
  onClose,
}: {
  saleId: number | null;
  /** true when this is a reprint (the ticket is marked as a copy). */
  copy?: boolean;
  onClose: () => void;
}) {
  const [html, setHtml] = useState("");
  const [width, setWidth] = useState<"80" | "58">("80");
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<PrintStatus>({ kind: "idle", message: "" });

  const load = useCallback(async () => {
    if (saleId === null) return;
    setLoading(true);
    setLoadError("");
    try {
      const r = await window.api.receipts.preview(saleId, copy);
      setHtml(r.html);
      setWidth(r.width);
    } catch (error) {
      setHtml("");
      setLoadError(describeIpcError(error, "No se pudo generar el recibo").message);
    } finally {
      setLoading(false);
    }
  }, [saleId, copy]);

  useEffect(() => {
    setStatus({ kind: "idle", message: "" });
    setHtml("");
    if (saleId !== null) load();
  }, [saleId, load]);

  const print = async () => {
    if (saleId === null || status.kind === "printing") return;
    setStatus({ kind: "printing", message: "Preparando impresión..." });
    try {
      const r = await window.api.receipts.print(saleId, copy);
      setStatus({ kind: r.status, message: r.status === "printed" ? `Recibo enviado a imprimir. ${r.message}` : r.message });
    } catch (error) {
      setStatus({ kind: "failed", message: describeIpcError(error, "No se pudo imprimir").message });
    }
  };

  return (
    <Dialog open={saleId !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Recibo de la venta #{saleId}</DialogTitle>
          <DialogDescription>
            Comprobante comercial, no fiscal. Imprimir no registra ni modifica la venta.
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-center bg-muted/40 rounded border p-2">
          {loading ? (
            <p className="py-16 text-sm text-muted-foreground">Generando recibo...</p>
          ) : loadError ? (
            <div className="py-10 text-center space-y-3">
              <p role="alert" className="text-sm text-red-600">{loadError}</p>
              <Button variant="outline" onClick={load}>Reintentar</Button>
            </div>
          ) : (
            <iframe
              title="Vista previa del recibo"
              sandbox=""
              srcDoc={html}
              style={{ width: width === "80" ? 320 : 240, height: 420, border: 0, background: "#fff" }}
            />
          )}
        </div>
        {status.kind !== "idle" && (
          <p
            role="status"
            data-testid="print-status"
            className={`text-sm rounded p-2 ${status.kind === "printed" ? "bg-green-50 text-green-800" : status.kind === "printing" ? "bg-muted" : "bg-amber-50 text-amber-900"}`}
          >
            {status.message}
          </p>
        )}
        <div className="flex gap-2">
          <Button onClick={print} disabled={loading || !!loadError || status.kind === "printing"} className="flex-1 gap-2 h-11">
            <Printer size={18} />
            {status.kind === "printing" ? "Imprimiendo..." : "Imprimir"}
          </Button>
          <Button variant="outline" onClick={onClose} className="flex-1 h-11">
            Cerrar
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
