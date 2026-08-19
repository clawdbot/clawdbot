// Qa Lab helper module supports vite behavior.
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  base: "./",
  resolve: {
    alias: {
      "@openclaw/normalization-core/error-coercion": path.resolve(
        import.meta.dirname,
        "../../../packages/normalization-core/src/error-coercion.ts",
      ),
      "openclaw/plugin-sdk/error-runtime": path.resolve(
        import.meta.dirname,
        "./src/error-runtime.browser.ts",
      ),
      "openclaw/plugin-sdk/text-utility-runtime": path.resolve(
        import.meta.dirname,
        "../../../packages/normalization-core/src/utf16-slice.ts",
      ),
    },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
  },
});
