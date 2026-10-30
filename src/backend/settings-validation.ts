/**
 * Validation of the commercial configuration used by receipts. Pure (no DB, no Electron), unit tested.
 * Nothing here is trusted: text is length-limited and stripped of control characters, the logo must be a real
 * PNG/JPEG data URL of limited size, and unknown fields are rejected. Output escaping happens again at render time.
 */
import { BusinessError } from "./errors.ts";

export const MAX_LOGO_BYTES = 200 * 1024;
export const PAPER_WIDTHS = ["80", "58"] as const;
export type PaperWidth = (typeof PAPER_WIDTHS)[number];

export type BusinessSettingsInput = {
  name: string;
  address: string | null;
  phone: string | null;
  whatsapp: string | null;
  taxInfo: string | null;
  footerMessage: string | null;
  returnPolicy: string | null;
  contactInfo: string | null;
  /** undefined = keep the stored logo, null = remove it, string = replace it. */
  logoData: string | null | undefined;
  paperWidth: PaperWidth;
  printerName: string | null;
  silentPrint: boolean;
};

const ALLOWED = [
  "name", "address", "phone", "whatsapp", "taxInfo", "footerMessage", "returnPolicy", "contactInfo",
  "logoData", "paperWidth", "printerName", "silentPrint",
];
// control characters except newline (multi-line fields), plus bidi overrides that could disguise printed text
const BAD_CHARS = /[\u0000-\u0009\u000b-\u001f\u007f‪-‮⁦-⁩]/;
const PHONE_RE = /^[0-9+()\-.\s]{3,40}$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function text(value: unknown, field: string, max: number, { required = false, multiline = false } = {}): string | null {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
    if (required) throw new BusinessError("CAMPO_INVALIDO", `${field}: es obligatorio`);
    return null;
  }
  if (typeof value !== "string") throw new BusinessError("CAMPO_INVALIDO", `${field}: texto inválido`);
  const v = value.replace(/\r\n?/g, "\n").trim();
  if (v.length > max) throw new BusinessError("CAMPO_INVALIDO", `${field}: máximo ${max} caracteres`);
  if (BAD_CHARS.test(v) || (!multiline && v.includes("\n"))) {
    throw new BusinessError("CAMPO_INVALIDO", `${field}: contiene caracteres no permitidos`);
  }
  return v;
}

function phone(value: unknown, field: string): string | null {
  const v = text(value, field, 40);
  if (v !== null && !PHONE_RE.test(v)) throw new BusinessError("CAMPO_INVALIDO", `${field}: usa solo dígitos, espacios y + ( ) - .`);
  return v;
}

/** Returns the same data URL when it is a genuine, small PNG or JPEG; throws otherwise. */
export function validateLogo(value: string): string {
  const m = /^data:(image\/png|image\/jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!m) throw new BusinessError("LOGO_INVALIDO", "El logotipo debe ser una imagen PNG o JPEG");
  const bytes = Buffer.from(m[2], "base64");
  if (bytes.length === 0 || bytes.length > MAX_LOGO_BYTES) {
    throw new BusinessError("LOGO_INVALIDO", `El logotipo no puede superar ${MAX_LOGO_BYTES / 1024} KB`);
  }
  const png = bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if ((m[1] === "image/png" && !png) || (m[1] === "image/jpeg" && !jpeg)) {
    throw new BusinessError("LOGO_INVALIDO", "El archivo no es una imagen válida");
  }
  return value;
}

export function parseBusinessSettings(data: unknown): BusinessSettingsInput {
  if (!isObject(data)) throw new BusinessError("CONFIGURACION_INVALIDA", "Datos de configuración inválidos");
  for (const key of Object.keys(data)) {
    if (!ALLOWED.includes(key)) throw new BusinessError("CAMPO_NO_PERMITIDO", `Campo no permitido: ${key}`);
  }
  const paper = data.paperWidth === undefined ? "80" : data.paperWidth;
  if (paper !== "80" && paper !== "58") throw new BusinessError("FORMATO_INVALIDO", "El papel debe ser de 80 mm o 58 mm");
  if (data.silentPrint !== undefined && typeof data.silentPrint !== "boolean") {
    throw new BusinessError("CAMPO_INVALIDO", "Impresión directa: valor inválido");
  }
  let logoData: string | null | undefined;
  if (data.logoData === undefined) logoData = undefined;
  else if (data.logoData === null || data.logoData === "") logoData = null;
  else if (typeof data.logoData === "string") logoData = validateLogo(data.logoData);
  else throw new BusinessError("LOGO_INVALIDO", "Logotipo inválido");

  const printerName = text(data.printerName, "Impresora", 200);
  const silentPrint = data.silentPrint === true;
  if (silentPrint && !printerName) {
    throw new BusinessError("CAMPO_INVALIDO", "La impresión directa requiere indicar la impresora");
  }
  return {
    name: text(data.name, "Nombre comercial", 120, { required: true }) as string,
    address: text(data.address, "Dirección", 300, { multiline: true }),
    phone: phone(data.phone, "Teléfono"),
    whatsapp: phone(data.whatsapp, "WhatsApp"),
    taxInfo: text(data.taxInfo, "Datos fiscales", 300, { multiline: true }),
    footerMessage: text(data.footerMessage, "Mensaje de pie", 300, { multiline: true }),
    returnPolicy: text(data.returnPolicy, "Política de devoluciones", 600, { multiline: true }),
    contactInfo: text(data.contactInfo, "Contacto", 300, { multiline: true }),
    logoData,
    paperWidth: paper,
    printerName,
    silentPrint,
  };
}
