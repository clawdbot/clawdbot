import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const fsSafeRoot = path.dirname(require.resolve("@openclaw/fs-safe/package.json"));
const requireFromFsSafe = createRequire(path.join(fsSafeRoot, "package.json"));
const manifest = JSON.parse(fs.readFileSync(path.join(fsSafeRoot, "package.json"), "utf8")) as {
  optionalDependencies: Record<string, string>;
};

// Nest platform packages under their declared owner so a hoisted development
// install cannot hide a bundled loader that resolves from the wrong package.
export function copyFsSafePackageFixture(packageRoot: string) {
  const dependencyRoot = path.join(packageRoot, "node_modules/@openclaw/fs-safe");
  fs.cpSync(fsSafeRoot, dependencyRoot, { recursive: true });
  const nativePackages: Array<{ name: string; root: string }> = [];
  for (const name of Object.keys(manifest.optionalDependencies)) {
    if (!name.startsWith("@openclaw/fs-safe-")) {
      continue;
    }
    let installed: string;
    try {
      installed = path.dirname(requireFromFsSafe.resolve(`${name}/package.json`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") {
        throw error;
      }
      continue;
    }
    const destination = path.join(dependencyRoot, "node_modules", name);
    fs.cpSync(installed, destination, { recursive: true });
    nativePackages.push({ name, root: destination });
  }
  return { dependencyRoot, nativePackages };
}
