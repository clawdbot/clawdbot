// Validates the current runtime against OpenClaw's Node engine floor.
import process from "node:process";
import { expectDefined } from "@openclaw/normalization-core";
import type { RuntimeEnv } from "../runtime.js";

// Runtime validation precedes terminal setup. Keep this default path from
// pulling terminal-core into every CLI startup command.
const defaultRuntime: RuntimeEnv = {
  log: (...args) => console.log(...args),
  error: (...args) => console.error(...args),
  exit: (code) => {
    process.exit(code);
  },
};

type RuntimeKind = "bun" | "node" | "unknown";

type Semver = {
  major: number;
  minor: number;
  patch: number;
};

const MIN_NODE_22: Semver = { major: 22, minor: 22, patch: 3 };
const MIN_NODE_24: Semver = { major: 24, minor: 15, patch: 0 };
const MIN_NODE_25: Semver = { major: 25, minor: 9, patch: 0 };
const MINIMUM_ENGINE_RE = /^\s*>=\s*v?(\d+\.\d+\.\d+)\s*$/i;
const ENGINE_CLAUSE_RE = /^\s*>=\s*v?(\d+\.\d+\.\d+)(?:\s+<\s*v?(\d+(?:\.\d+\.\d+)?))?\s*$/i;

/** Runtime facts included in startup/runtime-version diagnostics. */
type RuntimeDetails = {
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
function detectRuntime(): RuntimeDetails {
  const bunVersion = process.versions?.bun;
  const kind: RuntimeKind = bunVersion ? "bun" : process.versions?.node ? "node" : "unknown";
  const version = bunVersion ?? process.versions?.node ?? null;

  return {
    kind,
    version,
    execPath: process.execPath ?? null,
    pathEnv: process.env.PATH ?? "(not set)",
  };
}

/** Returns whether a detected runtime meets OpenClaw's minimum runtime contract. */
function runtimeSatisfies(details: RuntimeDetails): boolean {
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
  if (parsed.major === MIN_NODE_24.major) {
    return isAtLeast(parsed, MIN_NODE_24);
  }
  if (parsed.major === MIN_NODE_25.major) {
    return isAtLeast(parsed, MIN_NODE_25);
  }
  return parsed.major > MIN_NODE_25.major;
}

/** Parses simple package `engines.node` ranges of the form `>=x.y.z`. */
function parseMinimumNodeEngine(engine: string | null): Semver | null {
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

  if (!engine) {
    return null;
  }
  const parsed = parseSemver(version);
  if (!parsed) {
    return false;
  }

  const clauses = engine.split("||");
  let satisfied = false;
  for (const clause of clauses) {
    const match = clause.match(ENGINE_CLAUSE_RE);
    if (!match) {
      return null;
    }
    const clauseMinimum = parseSemver(match[1] ?? null);
    const upperRaw = match[2];
    const upper = upperRaw
      ? parseSemver(upperRaw.includes(".") ? upperRaw : `${upperRaw}.0.0`)
      : null;
    if (!clauseMinimum || (upperRaw && !upper)) {
      return null;
    }
    if (isAtLeast(parsed, clauseMinimum) && (!upper || !isAtLeast(parsed, upper))) {
      satisfied = true;
    }
  }
  return satisfied;
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
  const requirement =
    details.kind === "bun"
      ? "openclaw cannot run under Bun because the runtime does not provide node:sqlite."
      : "openclaw requires Node >=22.22.3 <23, >=24.15.0 <25, or >=25.9.0.";
  const retryHint =
    details.kind === "bun"
      ? "Run OpenClaw with Node; Bun remains supported for installs and package scripts."
      : "Upgrade Node and re-run openclaw.";

  runtime.error(
    [
      requirement,
      `Detected: ${runtimeLabel} (exec: ${execLabel}).`,
      `PATH searched: ${details.pathEnv}`,
      "Install Node: https://nodejs.org/en/download",
      retryHint,
    ].join("\n"),
  );
  runtime.exit(1);
}
