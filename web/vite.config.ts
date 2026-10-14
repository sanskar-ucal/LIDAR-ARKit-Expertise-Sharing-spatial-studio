import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const target = process.env.ROOMBRIDGE_SERVER ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": { target, changeOrigin: false },
      "/ws": { target: target.replace(/^http/, "ws"), ws: true },
    },
  },
  build: { outDir: "dist", sourcemap: false },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
