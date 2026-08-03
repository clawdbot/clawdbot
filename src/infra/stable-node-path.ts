// Resolves Homebrew Node binary paths to stable symlink targets.
import fs from "node:fs/promises";
import { stableHomebrewNodePathCandidates } from "@openclaw/normalization-core/stable-node-path";

/**
 * Homebrew Cellar paths (e.g. /opt/homebrew/Cellar/node/25.7.0/bin/node)
 * break when Homebrew upgrades Node and removes the old version directory.
 * Resolve these to a stable Homebrew-managed path that survives upgrades:
 *   - Default formula "node":  <prefix>/opt/node/bin/node  or  <prefix>/bin/node
 *   - Versioned formula "node@22":  <prefix>/opt/node@22/bin/node  (keg-only)
 */
export async function resolveStableNodePath(nodePath: string): Promise<string> {
  for (const candidate of stableHomebrewNodePathCandidates(nodePath)) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next Homebrew-managed stable path.
    }
  }
  return nodePath;
}
