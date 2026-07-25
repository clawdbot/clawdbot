import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";

const packageRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  clean: true,
  deps: { alwaysBundle: () => true },
  dts: false,
  entry: [join(packageRoot, "src", "cli.ts")],
  format: "esm",
  outDir: join(packageRoot, "dist"),
  platform: "node",
});
