import path from "node:path";
import { sha256Hex } from "./crypto-digest.js";
import { isPathInside } from "./path-guards.js";

// Keep path projection independent of snapshot orchestration: the snapshot owner
// dynamically loads plugin projection, so importing it back creates a worker build cycle.
/** Shared with config projection so custom agent directories use their copied database. */
export function resolveUpdateCandidateStatePath(
  sourceRoot: string,
  targetRoot: string,
  source: string,
): string {
  // Registered link/../ locators can identify a different inode from their
  // normalized spelling; flattening them would overwrite another copied database.
  const relative =
    path.normalize(source) === source && isPathInside(sourceRoot, source)
      ? path.relative(sourceRoot, source)
      : path.join("candidate-external", sha256Hex(source));
  return path.join(targetRoot, relative);
}

/** Plugin locators cannot overwrite the separately snapshotted state databases. */
export function resolveUpdateCandidatePluginPath(
  sourceRoot: string,
  targetRoot: string,
  source: string,
): string {
  const managed = ["npm", "extensions"].some((directory) =>
    isPathInside(path.join(sourceRoot, directory), source),
  );
  return managed
    ? resolveUpdateCandidateStatePath(sourceRoot, targetRoot, source)
    : path.join(
        targetRoot,
        "candidate-plugins",
        sha256Hex(path.parse(source).root),
        path.relative(path.parse(source).root, source),
      );
}
