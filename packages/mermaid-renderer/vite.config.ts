import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const output = fileURLToPath(new URL("../../apps/shared/mermaid/assets/mermaid", import.meta.url));

export default defineConfig({
  base: "./",
  // Native builds run directly from source, before workspace dist files exist.
  resolve: { tsconfigPaths: true },
  build: {
    outDir: output,
    emptyOutDir: true,
    assetsInlineLimit: 0,
    lib: {
      entry: fileURLToPath(new URL("./src/native.ts", import.meta.url)),
      name: "OpenClawMermaid",
      formats: ["iife"],
      fileName: () => "native.js",
    },
  },
  plugins: [
    {
      name: "native-mermaid-document",
      async closeBundle() {
        await mkdir(output, { recursive: true });
        await copyFile(new URL("./native/index.html", import.meta.url), `${output}/index.html`);
        await copyFile(new URL("./native/NOTICE.txt", import.meta.url), `${output}/NOTICE.txt`);
      },
    },
  ],
});
