import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [cloudflare()],
  // The CSP only allows same-origin fonts and scripts, so never inline assets as data: URIs.
  build: { assetsInlineLimit: 0 },
});
