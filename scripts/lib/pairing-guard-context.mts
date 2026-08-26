// Builds shared repo/source-root context for pairing guard scripts.
import path from "node:path";
import { resolveRepoRoot } from "./repo-root.mjs";
import { resolveSourceRoots } from "./ts-guard-utils.mts";

/** Create repo root and source root helpers for pairing guard scanners. */
export function createPairingGuardContext(importMetaUrl: string) {
  const repoRoot = resolveRepoRoot(importMetaUrl);
  const sourceRoots = resolveSourceRoots(repoRoot, ["src", "extensions"]);
  return {
    repoRoot,
    sourceRoots,
    resolveFromRepo: (relativePath: string) =>
      path.join(repoRoot, ...relativePath.split("/").filter(Boolean)),
  };
}
