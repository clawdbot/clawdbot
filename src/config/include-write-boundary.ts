// Resolves which authored $include file owns a config mutation, at any depth.
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "../utils.js";
import type { ConfigIncludeOwnership } from "./includes.js";

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
  if (isDeepStrictEqual(base, next)) {
    return { paths: [], rootChanged: false };
  }
  if (!isRecord(base) || !isRecord(next)) {
    return { paths: [], rootChanged: true };
  }
  const paths: string[][] = [];
  collectInto(base, next, [], paths);
  return { paths, rootChanged: paths.some((entry) => entry.length === 0) };
}

function isPathPrefix(prefix: readonly string[], candidate: readonly string[]): boolean {
  return (
    prefix.length <= candidate.length &&
    prefix.every((segment, index) => segment === candidate[index])
  );
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
  let best: IncludeWriteBoundary | null = null;
  let bestDepth = 0;
  for (const entry of provenance) {
    // Array-entry includes own a position inside a merged array, which a keyed
    // subtree write cannot express. Numeric object keys remain ordinary keys.
    if (
      !isSoleOwner(entry) ||
      !entry.targetPath ||
      entry.path.length === 0 ||
      entry.hasArrayAncestor
    ) {
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

/** Reads a keyed path out of an authored config value. */
export function readConfigPathValue(value: unknown, configPath: readonly string[]): unknown {
  let current = value;
  for (const segment of configPath) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

/** Returns a copy of `value` with `configPath` replaced by `nextValue`. */
export function writeConfigPathValue(
  value: unknown,
  configPath: readonly string[],
  nextValue: unknown,
): unknown {
  if (configPath.length === 0) {
    return nextValue;
  }
  // SAFETY: the zero-length case returns above, so a first segment exists.
  const [segment, ...rest] = configPath as [string, ...string[]];
  const base = isRecord(value) ? value : {};
  return {
    ...base,
    [segment]: writeConfigPathValue(base[segment], rest, nextValue),
  };
}

/** Whether an authored config value holds the keyed path at all. */
export function hasConfigPathValue(value: unknown, configPath: readonly string[]): boolean {
  let current = value;
  for (const segment of configPath) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      return false;
    }
    current = current[segment];
  }
  return true;
}
