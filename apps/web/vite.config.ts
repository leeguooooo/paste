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
        // `wrangler dev` default port in this repo is 8788
        target: "http://localhost:8788",
        changeOrigin: true,
      },
    },
  },
});
