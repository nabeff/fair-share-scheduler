import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    // The page only ever calls /api on its own address. While developing,
    // Vite passes those calls on to the API that docker compose started.
    // In Docker, nginx does the same (see nginx.conf).
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["src/test-setup.ts"],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
