import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
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
        start_url: "/"
      },
      workbox: {
        navigateFallback: "/index.html",
        // The application shell is small and always available offline. Heavy document,
        // embedding and WebLLM chunks are optional capabilities: cache them on first
        // use rather than forcing every PWA install to download tens of MiB.
        globPatterns: ["**/*.{css,html,svg,png,ico}", "assets/index-*.js", "assets/cytoscape.esm-*.js"],
        runtimeCaching: [
          {
            urlPattern: /\/assets\/.*\.(?:js|wasm)$/,
            handler: "CacheFirst",
            options: {
              cacheName: "evidenceweave-lazy-runtime-v1",
              expiration: { maxEntries: 40, maxAgeSeconds: 60 * 60 * 24 * 30 }
            }
          }
        ]
      }
    })
  ]
});
