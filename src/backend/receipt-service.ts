/**
 * Receipt preview and printing (main process). The renderer only ever sends a sale id: the document is built here
 * from PostgreSQL (sale, lines as sold, business settings), never from amounts supplied by the renderer.
 * Printing is a secondary action: it writes nothing to the database, so a failed or cancelled print can never
 * create, change or duplicate a sale.
 *
 * Automation (development builds ONLY, ignored when packaged): POS_PRINT_MODE_FILE names a file whose content is
 * "pdf" (write the print output to POS_PRINT_PDF_DIR), "cancel" or "fail". It allows the print path to be tested
 * without a printer or a system dialog.
 */
import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { BusinessError } from "./errors";
import { parseId } from "./validation";
import { getSaleDetail } from "./sales-history";
import type { Viewer } from "./sales-history";
import { getBusinessSettings } from "./settings-service";
import { renderReceiptHtml } from "./receipt";
import type { ReceiptData } from "./receipt";
import type { PaperWidth } from "./settings-validation";

export type PrintResult = { status: "printed" | "cancelled" | "failed"; message: string };

async function build(viewer: Viewer, saleIdRaw: unknown, copy: unknown) {
  const saleId = parseId(saleIdRaw, "VENTA_INVALIDA", "La venta");
  const detail = await getSaleDetail(viewer, saleId); // visibility rules + VENTA_NO_ENCONTRADA
  const settings = await getBusinessSettings();
  const data: ReceiptData = {
    folio: detail.sale.id,
    createdAt: detail.sale.createdAt,
    paymentMethod: detail.sale.paymentMethod,
    seller: detail.sale.sellerName,
    total: detail.sale.total,
    items: detail.items.map((i) => ({ name: i.name, sku: i.sku, quantity: i.quantity, unitPrice: i.unitPrice, subtotal: i.subtotal })),
  };
  const width = settings.paperWidth as PaperWidth;
  const html = renderReceiptHtml(data, settings, width, { copy: copy === true });
  return { html, width, folio: detail.sale.id, settings };
}

export async function previewReceipt(viewer: Viewer, saleId: unknown, copy: unknown) {
  const { html, width, folio } = await build(viewer, saleId, copy);
  return { html, width, folio };
}

let printing = false;

/** Hidden, script-less window that holds the receipt document for printing. */
async function loadInHiddenWindow(html: string) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false },
  });
  await win.loadURL("data:text/html;charset=utf-8;base64," + Buffer.from(html, "utf8").toString("base64"));
  const heightPx: number = await win.webContents.executeJavaScript("document.documentElement.scrollHeight");
  return { win, heightPx: Math.max(Number(heightPx) || 0, 200) };
}

const MICRONS_PER_PX = 264.583;
const pageSizeFor = (width: PaperWidth, heightPx: number) => ({
  width: Math.round(Number(width) * 1000),
  height: Math.max(Math.round(heightPx * MICRONS_PER_PX) + 5000, 100_000),
});

function testMode(): string | null {
  if (app.isPackaged) return null;
  const file = process.env.POS_PRINT_MODE_FILE;
  if (!file) return null;
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
}

export async function printReceipt(viewer: Viewer, saleId: unknown, copy: unknown): Promise<PrintResult> {
  if (printing) throw new BusinessError("IMPRESION_EN_CURSO", "Ya hay una impresión en curso");
  printing = true;
  let win: BrowserWindow | null = null;
  try {
    const { html, width, folio, settings } = await build(viewer, saleId, copy);
    const mode = testMode();
    if (mode === "cancel") return { status: "cancelled", message: "Impresión cancelada" };
    if (mode === "fail") return { status: "failed", message: "No se pudo imprimir (simulado)" };

    const loaded = await loadInHiddenWindow(html);
    win = loaded.win;
    const pageSize = pageSizeFor(width, loaded.heightPx);

    if (mode === "pdf") {
      const dir = process.env.POS_PRINT_PDF_DIR;
      if (!dir) return { status: "failed", message: "POS_PRINT_PDF_DIR no está definido" };
      const pdf = await win.webContents.printToPDF({
        pageSize: { width: pageSize.width / 25400, height: pageSize.height / 25400 }, // inches
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        printBackground: false,
      });
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `receipt-${folio}-${width}mm${copy === true ? "-copy" : ""}.pdf`);
      fs.writeFileSync(file, pdf);
      return { status: "printed", message: path.basename(file) };
    }

    const wc = win.webContents;
    let deviceName: string | undefined;
    let silent = false;
    if (settings.printerName) {
      const printers = await wc.getPrintersAsync();
      if (printers.some((p) => p.name === settings.printerName)) {
        deviceName = settings.printerName;
        silent = settings.silentPrint;
      }
    }
    return await new Promise<PrintResult>((resolve) => {
      wc.print(
        { silent, deviceName, printBackground: false, margins: { marginType: "none" }, pageSize },
        (success, reason) => {
          if (success) resolve({ status: "printed", message: "Enviado a la impresora" });
          else if (/cancel/i.test(reason)) resolve({ status: "cancelled", message: "Impresión cancelada" });
          else resolve({ status: "failed", message: "No se pudo imprimir. Revisa la impresora e inténtalo de nuevo." });
        }
      );
    });
  } finally {
    printing = false;
    if (win && !win.isDestroyed()) win.destroy();
  }
}

/** Installed printers (administrators only: used by the settings screen). */
export async function listPrinters(event: IpcMainInvokeEvent) {
  const printers = await event.sender.getPrintersAsync();
  return printers.map((p) => ({ name: p.name, displayName: p.displayName || p.name }));
}
