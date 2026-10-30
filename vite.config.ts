import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Content-Security-Policy for the packaged renderer (file://). Injected only into production builds: the dev server
// needs inline scripts for hot reload. Styles allow inline because Radix/Tailwind set style attributes.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const cspPlugin = {
  name: "pos-csp",
  apply: "build" as const,
  transformIndexHtml(html: string) {
    return html.replace("<head>", `<head>
    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
  },
};

export default defineConfig({
  // relative asset URLs: the packaged app loads index.html through file://
  base: "./",
  root: ".",
  plugins: [react(), cspPlugin],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src/renderer"),
      "@common": path.resolve(__dirname, "src/common"),
    },
  },
});
