// Validates the current runtime against OpenClaw's Node engine floor.
import process from "node:process";
import { expectDefined } from "@openclaw/normalization-core";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";

type RuntimeKind = "node" | "unknown";

type Semver = {
  major: number;
  minor: number;
  patch: number;
};

const MIN_NODE_22: Semver = { major: 22, minor: 19, patch: 0 };
const MIN_NODE_23: Semver = { major: 23, minor: 11, patch: 0 };
const MINIMUM_ENGINE_RE = /^\s*>=\s*v?(\d+\.\d+\.\d+)\s*$/i;
const DISJUNCTIVE_ENGINE_RE =
  /^\s*>=\s*v?(\d+\.\d+\.\d+)\s+<\s*v?(\d+)(?:\.(\d+)\.(\d+))?\s*\|\|\s*>=\s*v?(\d+\.\d+\.\d+)\s*$/i;

/** Runtime facts included in startup/runtime-version diagnostics. */
export type RuntimeDetails = {
  kind: RuntimeKind;
  version: string | null;
  execPath: string | null;
  pathEnv: string;
};

const SEMVER_RE = /(\d+)\.(\d+)\.(\d+)/;

/** Parses the first major/minor/patch triple from a runtime or package version label. */
export function parseSemver(version: string | null): Semver | null {
  if (!version) {
    return null;
  }
  const match = version.match(SEMVER_RE);
  if (!match) {
    return null;
  }
  const [, major, minor, patch] = match;
  return {
    major: Number.parseInt(expectDefined(major, "runtime guard major"), 10),
    minor: Number.parseInt(expectDefined(minor, "runtime guard minor"), 10),
    patch: Number.parseInt(expectDefined(patch, "runtime guard patch"), 10),
  };
}

/** Compares parsed semver triples against an inclusive minimum version. */
export function isAtLeast(version: Semver | null, minimum: Semver): boolean {
  if (!version) {
    return false;
  }
  if (version.major !== minimum.major) {
    return version.major > minimum.major;
  }
  if (version.minor !== minimum.minor) {
    return version.minor > minimum.minor;
  }
  return version.patch >= minimum.patch;
}

/** Reads current process runtime metadata for startup support checks. */
export function detectRuntime(): RuntimeDetails {
  const kind: RuntimeKind = process.versions?.node ? "node" : "unknown";
  const version = process.versions?.node ?? null;

  return {
    kind,
    version,
    execPath: process.execPath ?? null,
    pathEnv: process.env.PATH ?? "(not set)",
  };
}

/** Returns whether a detected runtime meets OpenClaw's minimum runtime contract. */
export function runtimeSatisfies(details: RuntimeDetails): boolean {
  if (details.kind === "node") {
    return isSupportedNodeVersion(details.version);
  }
  return false;
}

/** Checks a Node version label against OpenClaw's supported Node version range. */
export function isSupportedNodeVersion(version: string | null): boolean {
  const parsed = parseSemver(version);
  if (!parsed) {
    return false;
  }
  if (parsed.major === MIN_NODE_22.major) {
    return isAtLeast(parsed, MIN_NODE_22);
  }
  if (parsed.major === MIN_NODE_23.major) {
    return isAtLeast(parsed, MIN_NODE_23);
  }
  return parsed.major > MIN_NODE_23.major;
}

/** Parses simple package `engines.node` ranges of the form `>=x.y.z`. */
export function parseMinimumNodeEngine(engine: string | null): Semver | null {
  if (!engine) {
    return null;
  }
  const match = engine.match(MINIMUM_ENGINE_RE);
  if (!match) {
    return null;
  }
  return parseSemver(match[1] ?? null);
}

/** Returns whether a Node version satisfies a supported engine range, or null if unsupported. */
export function nodeVersionSatisfiesEngine(
  version: string | null,
  engine: string | null,
): boolean | null {
  const minimum = parseMinimumNodeEngine(engine);
  if (minimum) {
    return isAtLeast(parseSemver(version), minimum);
  }

  const rangeMatch = engine?.match(DISJUNCTIVE_ENGINE_RE);
  if (!rangeMatch) {
    return null;
  }
  const parsed = parseSemver(version);
  if (!parsed) {
    return false;
  }
  const [, firstMinimumRaw, upperMajorRaw, upperMinorRaw, upperPatchRaw, secondMinimumRaw] =
    rangeMatch;
  const firstMinimum = parseSemver(firstMinimumRaw ?? null);
  const secondMinimum = parseSemver(secondMinimumRaw ?? null);
  const upperBound: Semver = {
    major: Number.parseInt(upperMajorRaw ?? "", 10),
    minor: Number.parseInt(upperMinorRaw ?? "0", 10),
    patch: Number.parseInt(upperPatchRaw ?? "0", 10),
  };
  if (!firstMinimum || !secondMinimum || !Number.isFinite(upperBound.major)) {
    return null;
  }
  return (
    (isAtLeast(parsed, firstMinimum) && !isAtLeast(parsed, upperBound)) ||
    isAtLeast(parsed, secondMinimum)
  );
}

/** Exits through the provided runtime when the current Node runtime is unsupported. */
export function assertSupportedRuntime(
  runtime: RuntimeEnv = defaultRuntime,
  details: RuntimeDetails = detectRuntime(),
): void {
  if (runtimeSatisfies(details)) {
    return;
  }

  const versionLabel = details.version ?? "unknown";
  const runtimeLabel =
    details.kind === "unknown" ? "unknown runtime" : `${details.kind} ${versionLabel}`;
  const execLabel = details.execPath ?? "unknown";

  runtime.error(
    [
      "openclaw requires Node >=22.19.0 <23 or >=23.11.0.",
      `Detected: ${runtimeLabel} (exec: ${execLabel}).`,
      `PATH searched: ${details.pathEnv}`,
      "Install Node: https://nodejs.org/en/download",
      "Upgrade Node and re-run openclaw.",
    ].join("\n"),
  );
  runtime.exit(1);
}
