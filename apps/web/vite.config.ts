import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 3000,
    proxy: {
      "/v1": {
        // `wrangler dev` defaults to 8787; override if you run it elsewhere.
        target: process.env.PASTE_API_PROXY_TARGET || "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
