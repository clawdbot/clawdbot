/** Resolves the doctor-contract artifact shared by loading and installed-index hashing. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPluginCacheRoot } from "./plugin-cache.js";
import { resolvePluginRootArtifactPath } from "./root-artifact-path.js";

const CONTRACT_API_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"] as const;
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const RUNNING_FROM_BUILT_ARTIFACT =
  CURRENT_MODULE_PATH.includes(`${path.sep}dist${path.sep}`) ||
  CURRENT_MODULE_PATH.includes(`${path.sep}dist-runtime${path.sep}`);
const CACHE_KEY = `doctor-contract:${RUNNING_FROM_BUILT_ARTIFACT}`;
const ORDERED_EXTENSIONS = RUNNING_FROM_BUILT_ARTIFACT
  ? CONTRACT_API_EXTENSIONS
  : ([...CONTRACT_API_EXTENSIONS.slice(3), ...CONTRACT_API_EXTENSIONS.slice(0, 3)] as const);
// Keep this ordering stable: the installed index must hash the exact artifact
// that doctor contract loading would execute.
const ARTIFACT_PATHS = ["doctor-contract-api", "contract-api"].flatMap((basename) =>
  ORDERED_EXTENSIONS.flatMap((extension) => {
    const filename = `${basename}${extension}`;
    return [filename, path.join("dist", filename)];
  }),
);

export function resolvePluginDoctorContractArtifactPath(rootDir: string): string | null {
  const artifacts = getPluginCacheRoot(rootDir).artifacts;
  const cached = artifacts.get(CACHE_KEY);
  if (cached !== undefined) {
    return cached?.modulePath ?? null;
  }
  const modulePath = resolvePluginRootArtifactPath(rootDir, ARTIFACT_PATHS);
  artifacts.set(CACHE_KEY, modulePath ? { modulePath, boundaryRoot: rootDir } : null);
  return modulePath;
}
