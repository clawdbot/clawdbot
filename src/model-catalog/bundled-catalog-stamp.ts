import { createRequire } from "node:module";

const BUILD_INFO_CANDIDATES = [
  "../build-info.json",
  "../../build-info.json",
  "./build-info.json",
] as const;

/** Reads the package build stamp once through Node's JSON module cache. */
export function bundledCatalogGeneratedAt(moduleUrl = import.meta.url): number | undefined {
  const require = createRequire(moduleUrl);
  for (const candidate of BUILD_INFO_CANDIDATES) {
    try {
      const info = require(candidate) as { builtAt?: unknown };
      if (typeof info.builtAt !== "string") {
        continue;
      }
      const generatedAt = Date.parse(info.builtAt);
      if (Number.isFinite(generatedAt) && generatedAt > 0) {
        return generatedAt;
      }
    } catch {
      // Source/dev checkouts intentionally fail closed when no packaged stamp exists.
    }
  }
  return undefined;
}
