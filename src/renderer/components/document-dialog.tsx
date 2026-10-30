import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Printer } from "lucide-react";
import { describeIpcError } from "@/lib/ipc-error";

type PrintStatus = { kind: "idle" | "printing" | "printed" | "cancelled" | "failed"; message: string };

/**
 * Preview and print of a document built in the main process (receipt, cash summary). The preview is a script-less
 * sandboxed iframe; printing never writes anything to the database.
 */
export function DocumentDialog({
  open,
  title,
  description,
  iframeTitle,
  sentLabel,
  load,
  print,
  onClose,
}: {
  open: boolean;
  title: string;
  description: string;
  iframeTitle: string;
  /** what the status line says after a successful print, e.g. "Recibo enviado a imprimir" */
  sentLabel: string;
  load: () => Promise<{ html: string; width: "80" | "58" }>;
  print: () => Promise<{ status: "printed" | "cancelled" | "failed"; message: string }>;
  onClose: () => void;
}) {
  const [html, setHtml] = useState("");
  const [width, setWidth] = useState<"80" | "58">("80");
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<PrintStatus>({ kind: "idle", message: "" });
  const loadRef = useRef(load);
  loadRef.current = load;

  const run = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const r = await loadRef.current();
      setHtml(r.html);
      setWidth(r.width);
    } catch (error) {
      setHtml("");
      setLoadError(describeIpcError(error, "No se pudo generar el documento").message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setStatus({ kind: "idle", message: "" });
    setHtml("");
    if (open) void run();
  }, [open, run]);

  const doPrint = async () => {
    if (status.kind === "printing") return;
    setStatus({ kind: "printing", message: "Preparando impresión..." });
    try {
      const r = await print();
      setStatus({ kind: r.status, message: r.status === "printed" ? `${sentLabel}. ${r.message}` : r.message });
    } catch (error) {
      setStatus({ kind: "failed", message: describeIpcError(error, "No se pudo imprimir").message });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="flex justify-center bg-muted/40 rounded border p-2">
          {loading ? (
            <p className="py-16 text-sm text-muted-foreground">Generando documento...</p>
          ) : loadError ? (
            <div className="py-10 text-center space-y-3">
              <p role="alert" className="text-sm text-red-600">{loadError}</p>
              <Button variant="outline" onClick={run}>Reintentar</Button>
            </div>
          ) : (
            <iframe title={iframeTitle} sandbox="" srcDoc={html} style={{ width: width === "80" ? 320 : 240, height: 420, border: 0, background: "#fff" }} />
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
          <Button onClick={doPrint} disabled={loading || !!loadError || status.kind === "printing"} className="flex-1 gap-2 h-11">
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
