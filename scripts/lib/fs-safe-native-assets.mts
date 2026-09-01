import { createRequire } from "node:module";
import path from "node:path";

export function fsSafeNativeCopy({ outDir }: { outDir: string }) {
  const packageRoot = path.dirname(
    createRequire(import.meta.url).resolve("@openclaw/fs-safe/package.json"),
  );
  return {
    from: path.join(packageRoot, "dist/native"),
    // Runtime loaders and the sealed worker share one native tree. Private test
    // generations use the same layout inside their own output root.
    to: path.resolve(outDir, "..", "dist"),
  };
}
