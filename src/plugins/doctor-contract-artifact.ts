/** Resolves the doctor-contract artifact shared by loading and installed-index hashing. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pluginCacheExistsSync } from "./plugin-cache-files.js";
import { getPluginCacheRoot } from "./plugin-cache.js";

const CONTRACT_API_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"] as const;
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const RUNNING_FROM_BUILT_ARTIFACT =
  CURRENT_MODULE_PATH.includes(`${path.sep}dist${path.sep}`) ||
  CURRENT_MODULE_PATH.includes(`${path.sep}dist-runtime${path.sep}`);

export function resolvePluginDoctorContractArtifactPath(rootDir: string): string | null {
  const artifacts = getPluginCacheRoot(rootDir).artifacts;
  const key = `doctor-contract:${RUNNING_FROM_BUILT_ARTIFACT}`;
  const cached = artifacts.get(key);
  if (cached !== undefined) {
    return cached?.modulePath ?? null;
  }
  const modulePath = resolvePluginDoctorContractArtifactPathUncached(rootDir);
  artifacts.set(key, modulePath ? { modulePath, boundaryRoot: rootDir } : null);
  return modulePath;
}

function resolvePluginDoctorContractArtifactPathUncached(rootDir: string): string | null {
  const orderedExtensions = RUNNING_FROM_BUILT_ARTIFACT
    ? CONTRACT_API_EXTENSIONS
    : ([...CONTRACT_API_EXTENSIONS.slice(3), ...CONTRACT_API_EXTENSIONS.slice(0, 3)] as const);
  // Keep this ordering stable: the installed index must hash the exact artifact
  // that doctor contract loading would execute.
  for (const basename of ["doctor-contract-api", "contract-api"]) {
    for (const extension of orderedExtensions) {
      for (const baseDir of [rootDir, path.join(rootDir, "dist")]) {
        const candidate = path.join(baseDir, `${basename}${extension}`);
        if (pluginCacheExistsSync(candidate)) {
          return candidate;
        }
      }
    }
  }
  return null;
}
