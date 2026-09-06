// Extra-memory-path diagnostics for deep status and Doctor guidance.
import fs from "node:fs/promises";
import { normalizeExtraMemoryPathEntries, type NormalizedExtraMemoryPath } from "./internal.js";
import { shouldSkipRootMemoryAuxiliaryPath } from "./openclaw-runtime-memory.js";
import type { MemoryExtraPath } from "./types.js";

/**
 * Resolve configured extra-memory-path roots that are silently skipped at the
 * root level (currently: symlink roots). `listMemoryFiles` deliberately does
 * not traverse symlinks to preserve the filesystem trust boundary (#140214),
 * but a configured root that is itself a symlink contributes zero files with no
 * diagnostic, leaving a linked vault silently absent after migration.
 *
 * This function surfaces exactly those skipped roots so deep status and Doctor
 * diagnostics can recommend configuring the canonical absolute directory
 * instead.
 */
export async function resolveSkippedExtraMemoryPathRoots(
  workspaceDir: string,
  extraPaths?: MemoryExtraPath[],
): Promise<NormalizedExtraMemoryPath[]> {
  const skipped: NormalizedExtraMemoryPath[] = [];
  const normalizedExtraPaths = normalizeExtraMemoryPathEntries(workspaceDir, extraPaths);
  for (const entry of normalizedExtraPaths) {
    const inputPath = entry.path;
    if (shouldSkipRootMemoryAuxiliaryPath({ workspaceDir, absPath: inputPath })) {
      continue;
    }
    try {
      const stat = await fs.lstat(inputPath);
      if (stat.isSymbolicLink()) {
        skipped.push(entry);
      }
    } catch {
      // Missing paths are reported elsewhere; only surface symlink roots here.
    }
  }
  return skipped;
}
