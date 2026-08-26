/** Resolves the doctor-contract artifact shared by loading and installed-index hashing. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONTRACT_API_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"] as const;
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const RUNNING_FROM_BUILT_ARTIFACT =
  CURRENT_MODULE_PATH.includes(`${path.sep}dist${path.sep}`) ||
  CURRENT_MODULE_PATH.includes(`${path.sep}dist-runtime${path.sep}`);

export function resolvePluginDoctorContractArtifactPath(rootDir: string): string | null {
  const orderedExtensions = RUNNING_FROM_BUILT_ARTIFACT
    ? CONTRACT_API_EXTENSIONS
    : ([...CONTRACT_API_EXTENSIONS.slice(3), ...CONTRACT_API_EXTENSIONS.slice(0, 3)] as const);
  // Keep this ordering stable: the installed index must hash the exact artifact
  // that doctor contract loading would execute.
  for (const basename of ["doctor-contract-api", "contract-api"]) {
    for (const extension of orderedExtensions) {
      for (const baseDir of [rootDir, path.join(rootDir, "dist")]) {
        const candidate = path.join(baseDir, `${basename}${extension}`);
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }
  }
  return null;
}
