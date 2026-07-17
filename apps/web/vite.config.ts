import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite config for the Mill web prototype.
// The build output is static assets (runtime-agnostic) served by nginx in Docker.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
});
