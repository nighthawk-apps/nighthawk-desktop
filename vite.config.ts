import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

// Tauri loads the production frontend over a custom asset protocol.
// Absolute `/assets/...` URLs break there and yield a blank white window.
export default defineConfig(async () => ({
  clearScreen: false,
  base: "./",
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));
