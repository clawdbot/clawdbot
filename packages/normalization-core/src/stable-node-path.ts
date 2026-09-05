import path from "node:path";
import { expectDefined } from "./expect.js";

/**
 * Returns stable Homebrew paths for a versioned Cellar Node executable.
 * Availability remains caller-owned so packages can reuse the path contract
 * without importing another package's filesystem/runtime layer.
 */
export function stableHomebrewNodePathCandidates(nodePath: string): string[] {
  const cellarMatch = nodePath.match(
    /^(.+?)[\\/]Cellar[\\/]([^\\/]+)[\\/][^\\/]+[\\/]bin[\\/]node$/,
  );
  if (!cellarMatch) {
    return [];
  }

  const prefix = expectDefined(cellarMatch[1], "cellar match capture group 1");
  const formula = expectDefined(cellarMatch[2], "cellar match capture group 2");
  const pathModule = nodePath.includes("\\") ? path.win32 : path.posix;
  const candidates = [pathModule.join(prefix, "opt", formula, "bin", "node")];
  if (formula === "node") {
    candidates.push(pathModule.join(prefix, "bin", "node"));
  }
  return candidates;
}
