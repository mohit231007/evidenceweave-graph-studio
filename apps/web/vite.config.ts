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
        globPatterns: ["**/*.{js,css,html,svg,png,ico}"]
      }
    })
  ]
});
