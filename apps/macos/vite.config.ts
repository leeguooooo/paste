import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const parsePort = (raw: unknown, fallback: number) => {
  const n = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0 || n >= 65536) return fallback;
  return n;
};

const devPort = parsePort(process.env.PASTE_DEV_PORT ?? process.env.VITE_PORT, 5174);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src")
    }
  },
  server: {
    host: "127.0.0.1",
    port: devPort,
    strictPort: true
  },
  build: {
    outDir: "dist"
  }
});
