import path from "node:path";
import { pluginCacheExistsSync } from "./plugin-cache-files.js";

/** Resolves artifact paths in the caller's layout and filename preference order. */
export function resolvePluginRootArtifactPath(
  rootDir: string,
  artifactPaths: readonly string[],
): string | null {
  for (const artifactPath of artifactPaths) {
    const candidate = path.join(rootDir, artifactPath);
    if (pluginCacheExistsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}
