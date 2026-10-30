import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { POSLayout } from "@/components/pos-layout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { describeIpcError } from "@/lib/ipc-error";

interface User {
  id: number;
  name: string;
  role: "admin" | "vendor";
}
interface Form {
  name: string;
  address: string;
  phone: string;
  whatsapp: string;
  taxInfo: string;
  contactInfo: string;
  footerMessage: string;
  returnPolicy: string;
  paperWidth: "80" | "58";
  printerName: string;
  silentPrint: boolean;
}

const MAX_LOGO = 200 * 1024;
const fromRow = (r: any): Form => ({
  name: r.name ?? "",
  address: r.address ?? "",
  phone: r.phone ?? "",
  whatsapp: r.whatsapp ?? "",
  taxInfo: r.taxInfo ?? "",
  contactInfo: r.contactInfo ?? "",
  footerMessage: r.footerMessage ?? "",
  returnPolicy: r.returnPolicy ?? "",
  paperWidth: r.paperWidth === "58" ? "58" : "80",
  printerName: r.printerName ?? "",
  silentPrint: r.silentPrint === true,
});

export default function SettingsPage() {
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [logo, setLogo] = useState<string | null>(null); // what is stored / will be stored
  const [logoChanged, setLogoChanged] = useState(false);
  const [printers, setPrinters] = useState<{ name: string; displayName: string }[]>([]);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadedRef = useRef(false);
  const load = useCallback(async () => {
    // The printer list can take a while to enumerate: it loads on its own and never delays or resets the form.
    window.api.receipts.listPrinters().then(setPrinters).catch(() => setPrinters([]));
    try {
      setLoadError("");
      const row = await window.api.settings.getBusiness();
      if (loadedRef.current) return; // a second load (development double-mount) must not overwrite what is being typed
      loadedRef.current = true;
      setForm(fromRow(row));
      setLogo(row.logoData ?? null);
      setLogoChanged(false);
    } catch (e) {
      setLoadError(describeIpcError(e, "No se pudo cargar la configuración").message);
    }
  }, []);

  useEffect(() => {
    const userStr = sessionStorage.getItem("user");
    if (!userStr) {
      navigate("/");
      return;
    }
    const parsed = JSON.parse(userStr);
    if (parsed.role !== "admin") {
      navigate("/sales");
      return;
    }
    setUser(parsed);
    load();
  }, [navigate, load]);

  const pickLogo = (file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type)) {
      toast.error("El logotipo debe ser una imagen PNG o JPEG");
      return;
    }
    if (file.size > MAX_LOGO) {
      toast.error(`El logotipo no puede superar ${MAX_LOGO / 1024} KB`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setLogo(String(reader.result));
      setLogoChanged(true);
    };
    reader.onerror = () => toast.error("No se pudo leer la imagen");
    reader.readAsDataURL(file);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
    try {
      const saved = await window.api.settings.updateBusiness({
        ...form,
        ...(logoChanged ? { logoData: logo } : {}),
      });
      setForm(fromRow(saved));
      setLogo(saved.logoData ?? null);
      setLogoChanged(false);
      toast.success("Configuración guardada");
    } catch (error) {
      toast.error(describeIpcError(error, "No se pudo guardar la configuración").message);
    } finally {
      setSaving(false);
    }
  };

  if (!user) return null;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const field = (id: string, label: string, el: React.ReactNode, hint?: string) => (
    <div>
      <label htmlFor={id} className="text-sm font-semibold block mb-1">{label}</label>
      {el}
      {hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
    </div>
  );

  return (
    <POSLayout>
      <div className="p-4 md:p-6 max-w-3xl mx-auto">
        <h1 className="text-2xl md:text-3xl font-bold mb-1">Configuración comercial</h1>
        <p className="text-sm text-muted-foreground mb-4">
          Datos que aparecen en el recibo. Lo que dejes vacío no se imprime; el sistema no inventa direcciones, teléfonos ni datos fiscales.
        </p>

        {loadError ? (
          <Card className="text-center py-10 px-4">
            <p role="alert" className="text-red-600 mb-4">{loadError}</p>
            <Button onClick={load}>Reintentar</Button>
          </Card>
        ) : !form ? (
          <div className="flex justify-center py-16">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
          </div>
        ) : (
          <form onSubmit={save} className="space-y-4">
            <Card className="p-4 space-y-3">
              <h2 className="font-semibold">Negocio</h2>
              {field("bs-name", "Nombre comercial", <Input id="bs-name" value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={120} className="h-11" />)}
              {field("bs-address", "Dirección del establecimiento", <Textarea id="bs-address" value={form.address} onChange={(e) => set("address", e.target.value)} maxLength={300} rows={2} />)}
              <div className="grid sm:grid-cols-2 gap-3">
                {field("bs-phone", "Teléfono", <Input id="bs-phone" inputMode="tel" value={form.phone} onChange={(e) => set("phone", e.target.value)} maxLength={40} className="h-11" />)}
                {field("bs-whatsapp", "WhatsApp", <Input id="bs-whatsapp" inputMode="tel" value={form.whatsapp} onChange={(e) => set("whatsapp", e.target.value)} maxLength={40} className="h-11" />)}
              </div>
              {field("bs-contact", "Otros datos de contacto", <Input id="bs-contact" value={form.contactInfo} onChange={(e) => set("contactInfo", e.target.value)} maxLength={300} className="h-11" />)}
              {field("bs-tax", "Datos fiscales (opcional)", <Textarea id="bs-tax" value={form.taxInfo} onChange={(e) => set("taxInfo", e.target.value)} maxLength={300} rows={2} />, "Solo se imprimen si los capturas. El recibo sigue siendo un comprobante comercial, no una factura.")}
              <div>
                <span className="text-sm font-semibold block mb-1">Logotipo (PNG o JPEG, máximo 200 KB)</span>
                <div className="flex items-center gap-3 flex-wrap">
                  {logo ? <img src={logo} alt="Logotipo actual" className="h-16 max-w-40 object-contain border rounded bg-white p-1" /> : <span className="text-sm text-muted-foreground">Sin logotipo</span>}
                  <input ref={fileRef} type="file" accept="image/png,image/jpeg" aria-label="Seleccionar logotipo" onChange={(e) => pickLogo(e.target.files?.[0])} className="text-sm" />
                  {logo && (
                    <Button type="button" variant="outline" onClick={() => { setLogo(null); setLogoChanged(true); if (fileRef.current) fileRef.current.value = ""; }}>
                      Quitar logotipo
                    </Button>
                  )}
                </div>
              </div>
            </Card>

            <Card className="p-4 space-y-3">
              <h2 className="font-semibold">Pie del recibo</h2>
              {field("bs-footer", "Mensaje de pie", <Textarea id="bs-footer" value={form.footerMessage} onChange={(e) => set("footerMessage", e.target.value)} maxLength={300} rows={2} />, "Si lo dejas vacío se imprime «¡Gracias por su compra!».")}
              {field("bs-policy", "Condiciones o política de devoluciones", <Textarea id="bs-policy" value={form.returnPolicy} onChange={(e) => set("returnPolicy", e.target.value)} maxLength={600} rows={3} />)}
            </Card>

            <Card className="p-4 space-y-3">
              <h2 className="font-semibold">Impresión</h2>
              {field(
                "bs-paper",
                "Formato de papel",
                <select id="bs-paper" value={form.paperWidth} onChange={(e) => set("paperWidth", e.target.value as "80" | "58")} className="h-11 w-full border rounded-md px-3 bg-background">
                  <option value="80">Rollo de 80 mm</option>
                  <option value="58">Rollo de 58 mm</option>
                </select>
              )}
              {field(
                "bs-printer",
                "Impresora predeterminada",
                <select
                  id="bs-printer"
                  value={form.printerName}
                  onChange={(e) => setForm((f) => (f ? { ...f, printerName: e.target.value, silentPrint: e.target.value ? f.silentPrint : false } : f))}
                  className="h-11 w-full border rounded-md px-3 bg-background"
                >
                  <option value="">Preguntar al imprimir (diálogo del sistema)</option>
                  {form.printerName && !printers.some((p) => p.name === form.printerName) && <option value={form.printerName}>{form.printerName} (no detectada)</option>}
                  {printers.map((p) => (
                    <option key={p.name} value={p.name}>{p.displayName}</option>
                  ))}
                </select>,
                printers.length === 0 ? "No se detectó ninguna impresora instalada en este equipo." : undefined
              )}
              <label className="flex items-center gap-2 text-sm min-h-11">
                <input type="checkbox" checked={form.silentPrint} disabled={!form.printerName} onChange={(e) => set("silentPrint", e.target.checked)} className="h-5 w-5" />
                Imprimir directo, sin mostrar el diálogo (requiere impresora predeterminada)
              </label>
            </Card>

            <Button type="submit" disabled={saving} className="btn-pos-success w-full h-12 text-lg">
              {saving ? "Guardando..." : "Guardar configuración"}
            </Button>
          </form>
        )}
      </div>
    </POSLayout>
  );
}
