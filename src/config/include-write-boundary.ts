// Resolves which authored $include file owns a config mutation, at any depth.
import { isDeepStrictEqual } from "node:util";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { isRecord } from "../utils.js";
import { isInternalIncludeWriteTarget, type ConfigIncludeOwnership } from "./includes.js";

/** Authored include boundary that can absorb a whole config mutation. */
export type IncludeWriteBoundary = {
  /** Logical config path the include directive is authored at. */
  boundaryPath: readonly string[];
  /** Resolved include file path recorded while reading the snapshot. */
  includePath: string;
};

/** Changed leaf paths between two authored config values. */
export type ChangedConfigPaths = {
  paths: readonly (readonly string[])[];
  /** Whether the values differ in a way no keyed boundary can own. */
  rootChanged: boolean;
};

function collectInto(
  base: unknown,
  next: unknown,
  prefix: readonly string[],
  output: string[][],
): void {
  if (isDeepStrictEqual(base, next)) {
    return;
  }
  if (!isRecord(base) || !isRecord(next)) {
    output.push([...prefix]);
    return;
  }
  for (const key of new Set([...Object.keys(base), ...Object.keys(next)])) {
    if (!Object.hasOwn(base, key) || !Object.hasOwn(next, key)) {
      output.push([...prefix, key]);
      continue;
    }
    collectInto(base[key], next[key], [...prefix, key], output);
  }
}

/**
 * Lists the changed keyed paths between two authored configs. Arrays and
 * primitives compare whole, so a changed array reports its own path rather than
 * per-index paths an include boundary could not own positionally.
 */
export function collectChangedConfigPaths(base: unknown, next: unknown): ChangedConfigPaths {
  const paths: string[][] = [];
  collectInto(base, next, [], paths);
  const rootChanged = paths.some((entry) => entry.length === 0);
  return { paths: rootChanged ? [] : paths, rootChanged };
}

function isPathPrefix(prefix: readonly string[], candidate: readonly string[]): boolean {
  return (
    prefix.length <= candidate.length &&
    prefix.every((segment, index) => segment === candidate[index])
  );
}

function pathsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

function pathTouchesAgentRoster(path: readonly string[]): boolean {
  return [
    ["agents", "entries"],
    ["agents", "list"],
  ].some((rosterPath) => isPathPrefix(path, rosterPath) || isPathPrefix(rosterPath, path));
}

function isKeyedAgentEntryPath(path: readonly string[]): boolean {
  return path.length === 3 && path[0] === "agents" && path[1] === "entries";
}

function isSoleOwner(entry: ConfigIncludeOwnership): boolean {
  // A merged directive or one carrying sibling overrides does not solely own the
  // value it contributes, so its file cannot absorb a write on its own.
  return entry.kind === "single" && !entry.hasSiblingOverrides;
}

/**
 * Finds the deepest authored include that solely owns every changed path.
 *
 * A boundary is writable only when it names exactly one file, carries no
 * sibling overrides, every enclosing include is itself a sole owner —
 * otherwise an ancestor could merge over the included content — and no deeper
 * include was recorded beneath it, since a file that still authors $include
 * directives cannot absorb a write. The deepest such boundary wins so the
 * write stays in the narrowest owning file rather than flattening a nested
 * include into its parent.
 */
export function resolveIncludeWriteBoundary(params: {
  provenance: readonly ConfigIncludeOwnership[] | undefined;
  changed: ChangedConfigPaths;
}): IncludeWriteBoundary | null {
  const provenance = params.provenance;
  if (!provenance || params.changed.rootChanged || params.changed.paths.length === 0) {
    return null;
  }
  // A root-level $include is read-only for OpenClaw-owned writes (documented
  // contract): its file shapes every section, so no nested boundary beneath it
  // may absorb a write even when both are sole owners.
  if (provenance.some((entry) => entry.path.length === 0)) {
    return null;
  }
  const targets = provenance.flatMap(
    (entry) => entry.targetPaths ?? (entry.targetPath ? [entry.targetPath] : []),
  );
  const canonicalTargets = new Map(
    [...new Set(targets)].map((target) => [target, resolvePathViaExistingAncestorSync(target)]),
  );
  let best: IncludeWriteBoundary | null = null;
  let bestDepth = 0;
  for (const entry of provenance) {
    // Array-entry includes own a position inside a merged array, which a keyed
    // subtree write cannot express. Numeric object keys remain ordinary keys.
    if (!isSoleOwner(entry) || !entry.targetPath || entry.hasArrayAncestor) {
      continue;
    }
    const enclosingMerges = provenance.some(
      (candidate) =>
        candidate !== entry &&
        candidate.path.length <= entry.path.length &&
        isPathPrefix(candidate.path, entry.path) &&
        !isSoleOwner(candidate),
    );
    if (enclosingMerges) {
      continue;
    }
    // A strictly deeper include event under this entry means its authored value
    // still carries $include directives; the guarded writer declines such a
    // file, so selecting it would only defer the failure to the root flatten
    // guard after Doctor already advertised the path as writable.
    const containsDeeperInclude = provenance.some(
      (candidate) =>
        candidate !== entry &&
        candidate.path.length > entry.path.length &&
        isPathPrefix(entry.path, candidate.path),
    );
    if (containsDeeperInclude) {
      continue;
    }
    if (!params.changed.paths.every((changedPath) => isPathPrefix(entry.path, changedPath))) {
      continue;
    }
    // A physical file reused elsewhere would also change an unrequested subtree,
    // including when the other owner merges it or reaches it through an alias.
    const canonicalTarget = canonicalTargets.get(entry.targetPath);
    const sharedTarget = provenance.some(
      (candidate) =>
        !pathsEqual(candidate.path, entry.path) &&
        (candidate.targetPaths ?? (candidate.targetPath ? [candidate.targetPath] : [])).some(
          (target) => canonicalTargets.get(target) === canonicalTarget,
        ),
    );
    if (sharedTarget) {
      continue;
    }
    // Include events fire depth-first, so a same-path delegation chain records
    // the innermost authored file before its delegating parents. Strict
    // comparison keeps that first candidate; replacing it would select an outer
    // file that still contains a $include directive and cannot absorb a write.
    if (entry.path.length > bestDepth) {
      best = { boundaryPath: entry.path, includePath: entry.targetPath };
      bestDepth = entry.path.length;
    }
  }
  return best;
}

/** Exact keyed-entry includes whose authored pointers may survive a root-owned roster edit. */
export function resolveKeyedAgentEntryIncludePreservation(params: {
  configPath: string;
  provenance: readonly ConfigIncludeOwnership[] | undefined;
}): { includePaths: readonly (readonly string[])[] } | null {
  const provenance = params.provenance;
  if (!provenance) {
    return null;
  }
  const rosterOwnership = provenance.filter((entry) => pathTouchesAgentRoster(entry.path));
  if (
    rosterOwnership.length === 0 ||
    rosterOwnership.some((entry) => !isKeyedAgentEntryPath(entry.path))
  ) {
    return null;
  }

  const includePaths: string[][] = [];
  for (const entry of rosterOwnership) {
    // Same-path delegation is ambiguous for preservation even though a direct include write can
    // select the innermost file: the root must retain the outer directive without flattening it.
    if (
      rosterOwnership.filter((candidate) => pathsEqual(candidate.path, entry.path)).length !== 1
    ) {
      return null;
    }
    const boundary = resolveIncludeWriteBoundary({
      provenance,
      changed: { paths: [[...entry.path, "$value"]], rootChanged: false },
    });
    if (
      !boundary ||
      !pathsEqual(boundary.boundaryPath, entry.path) ||
      boundary.includePath !== entry.targetPath ||
      !isInternalIncludeWriteTarget({
        configPath: params.configPath,
        includePath: boundary.includePath,
      })
    ) {
      return null;
    }
    includePaths.push([...entry.path]);
  }
  return { includePaths };
}
