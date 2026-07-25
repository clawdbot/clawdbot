// Resolves Homebrew Node binary paths to stable symlink targets.
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";

/**
 * Homebrew Cellar paths (e.g. /opt/homebrew/Cellar/node/25.7.0/bin/node)
 * break when Homebrew upgrades Node and removes the old version directory.
 * Resolve these to a stable Homebrew-managed path that survives upgrades:
 *   - Default formula "node":  <prefix>/opt/node/bin/node  or  <prefix>/bin/node
 *   - Versioned formula "node@22":  <prefix>/opt/node@22/bin/node  (keg-only)
 */
export async function resolveStableNodePath(nodePath: string): Promise<string> {
  const cellarMatch = nodePath.match(
    /^(.+?)[\\/]Cellar[\\/]([^\\/]+)[\\/][^\\/]+[\\/]bin[\\/]node$/,
  );
  if (!cellarMatch) {
    return nodePath;
  }
  const prefix = expectDefined(cellarMatch[1], "cellar match capture group 1"); // e.g. /opt/homebrew
  const formula = expectDefined(cellarMatch[2], "cellar match capture group 2"); // e.g. "node" or "node@22"
  const pathModule = nodePath.includes("\\") ? path.win32 : path.posix;

  // Try the Homebrew opt symlink first — works for both default and versioned formulas.
  const optPath = pathModule.join(prefix, "opt", formula, "bin", "node");
  try {
    await fs.access(optPath);
    return optPath;
  } catch {
    // fall through
  }

  // For the default "node" formula, also try the direct bin symlink.
  if (formula === "node") {
    const binPath = pathModule.join(prefix, "bin", "node");
    try {
      await fs.access(binPath);
      return binPath;
    } catch {
      // fall through
    }
  }

  return nodePath;
}
