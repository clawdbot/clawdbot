// Builds shared repo/source-root context for pairing guard scripts.
import path from "node:path";
import { resolveRepoRoot, resolveSourceRoots } from "./ts-guard-utils.mjs";

/** Create repo root and source root helpers for pairing guard scanners. */
export function createPairingGuardContext(importMetaUrl) {
  const repoRoot = resolveRepoRoot(importMetaUrl);
  const sourceRoots = resolveSourceRoots(repoRoot, ["src", "extensions"]);
  return {
    repoRoot,
    sourceRoots,
    resolveFromRepo: (relativePath) =>
      path.join(repoRoot, ...relativePath.split("/").filter(Boolean)),
  };
}
