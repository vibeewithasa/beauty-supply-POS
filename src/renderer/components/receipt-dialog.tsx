import { DocumentDialog } from "@/components/document-dialog";

/**
 * Receipt preview and printing for a persisted sale. The renderer only sends the sale id: the document is built in
 * the main process from PostgreSQL.
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
  return (
    <DocumentDialog
      key={`${saleId}-${copy}`}
      open={saleId !== null}
      title={`Recibo de la venta #${saleId}`}
      description="Comprobante comercial, no fiscal. Imprimir no registra ni modifica la venta."
      iframeTitle="Vista previa del recibo"
      sentLabel="Recibo enviado a imprimir"
      load={() => window.api.receipts.preview(saleId as number, copy)}
      print={() => window.api.receipts.print(saleId as number, copy)}
      onClose={onClose}
    />
  );
}
