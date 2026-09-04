import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function resolveNodePackageBin(
  tool: string,
  requireFromPackage: ReturnType<typeof createRequire>,
): string {
  // Hoisting can leave executable local shims pointing at removed packages.
  // Resolve the declared bin from the caller's actual dependency scope instead.
  const manifestPath = requireFromPackage.resolve(`${tool}/package.json`);
  const { bin } = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    bin: Record<string, string>;
  };
  const entry = bin[tool];
  if (!entry) {
    throw new Error(`${tool} does not declare its executable`);
  }
  return path.resolve(path.dirname(manifestPath), entry);
}

if (import.meta.main) {
  const tool = process.argv[2];
  if (!tool) {
    throw new Error("Usage: node scripts/run-node-package-bin.mts <package> [...args]");
  }
  const entry = resolveNodePackageBin(tool, createRequire(path.resolve("package.json")));
  process.argv.splice(1, 2, entry);
  await import(pathToFileURL(entry).href);
}
