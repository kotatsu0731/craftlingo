import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

const crossOriginIsolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

const isVitest = Boolean(
  (globalThis as { process?: { env?: { VITEST?: string } } }).process?.env?.VITEST,
);

export default defineConfig({
  plugins: [react(), ...(isVitest ? [] : [cloudflare()])],
  server: { headers: crossOriginIsolationHeaders },
  preview: { headers: crossOriginIsolationHeaders },
  test: {
    environment: "jsdom",
  },
});
