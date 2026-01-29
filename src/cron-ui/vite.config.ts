import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname),
  base: "/ui/cron/",
  build: {
    outDir: resolve(__dirname, "../../dist/cron-ui"),
    emptyOutDir: true,
    target: "esnext",
  },
});
