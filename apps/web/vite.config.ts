import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

const base = process.env.VITE_BASE_PATH || "/";
const normalizedBase = base.endsWith("/") ? base : `${base}/`;

export default defineConfig({
  base: normalizedBase,
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "EvidenceWeave Graph Studio",
        short_name: "EvidenceWeave",
        description: "Own your knowledge. Map every connection. Verify every answer.",
        theme_color: "#101319",
        background_color: "#0b0e13",
        display: "standalone",
        scope: normalizedBase,
        start_url: normalizedBase
      },
      workbox: {
        navigateFallback: `${normalizedBase}index.html`,
        // The application shell is small and always available offline. Heavy document,
        // embedding and WebLLM chunks are optional capabilities: cache them on first
        // use rather than forcing every PWA install to download tens of MiB.
        globPatterns: ["**/*.{css,html,svg,png,ico}", "assets/index-*.js", "assets/cytoscape.esm-*.js"],
        runtimeCaching: [
          {
            urlPattern: /\/assets\/.*\.(?:js|wasm)$/,
            handler: "CacheFirst",
            options: {
              cacheName: "evidenceweave-lazy-runtime-v2",
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 * 30 }
            }
          }
        ]
      }
    })
  ]
});
