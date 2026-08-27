// Validates the current runtime against OpenClaw's Node engine floor.
import process from "node:process";
import { format } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import {
  isNodeVersionAtLeast,
  isSupportedOpenClawNodeVersion,
  parseNodeReleaseVersion,
} from "../../node-version.mjs";
import { formatConsoleDiagnosticBlock } from "../logging/json-console-line.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  detectCurrentRuntimeSqliteVersion,
  isSqliteWalResetSafeVersion,
} from "./sqlite-runtime-version.js";

// Runtime validation precedes console capture. Keep this direct sink aligned
// with configured JSONL output without pulling in the full logger.
const defaultRuntime: RuntimeEnv = {
  log: (...args) => console.log(...args),
  error: (...args) => {
    const message = format(...args);
    process.stderr.write(formatConsoleDiagnosticBlock({ level: "error", message: `${message}\n` }));
  },
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

const MINIMUM_BUN_VERSION: Semver = { major: 1, minor: 4, patch: 0 };

const MINIMUM_ENGINE_RE = /^\s*>=\s*v?(\d+\.\d+\.\d+)\s*$/i;
const ENGINE_CLAUSE_RE = /^\s*>=\s*v?(\d+\.\d+\.\d+)(?:\s+<\s*v?(\d+(?:\.\d+\.\d+)?))?\s*$/i;

/** Runtime facts included in startup/runtime-version diagnostics. */
type RuntimeDetails = {
  kind: RuntimeKind;
  version: string | null;
  execPath: string | null;
  pathEnv: string;
  hasNodeSqlite: boolean;
  sqliteVersion: string | null;
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
function isAtLeast(version: Semver | null, minimum: Semver): boolean {
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
  const sqlite =
    kind === "bun" ? detectCurrentRuntimeSqlite() : { available: false, version: null };

  return {
    kind,
    version,
    execPath: process.execPath ?? null,
    pathEnv: process.env.PATH ?? "(not set)",
    hasNodeSqlite: sqlite.available,
    sqliteVersion: sqlite.version,
  };
}

function detectCurrentRuntimeSqlite(): { available: boolean; version: string | null } {
  try {
    const version = detectCurrentRuntimeSqliteVersion();
    return { available: version !== null, version };
  } catch {
    return { available: false, version: null };
  }
}

/** Returns whether a detected runtime meets OpenClaw's minimum runtime contract. */
function runtimeSatisfies(details: RuntimeDetails): boolean {
  if (details.kind === "node") {
    return isSupportedNodeVersion(details.version);
  }
  if (details.kind === "bun") {
    return (
      isSupportedBunVersion(details.version) &&
      details.hasNodeSqlite &&
      details.sqliteVersion !== null &&
      isSqliteWalResetSafeVersion(details.sqliteVersion)
    );
  }
  return false;
}

/** Returns whether the current process runtime satisfies OpenClaw's engine contract. */
export function isCurrentRuntimeSupported(): boolean {
  return runtimeSatisfies(detectRuntime());
}

/** Checks a Node version label against OpenClaw's supported Node version range. */
export function isSupportedNodeVersion(version: string | null): boolean {
  return isSupportedOpenClawNodeVersion(version);
}

/** Checks a Bun version label against OpenClaw's minimum supported release. */
export function isSupportedBunVersion(version: string | null): boolean {
  return isAtLeast(parseSemver(version), MINIMUM_BUN_VERSION);
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
    return isNodeVersionAtLeast(parseNodeReleaseVersion(version), minimum);
  }

  if (!engine) {
    return null;
  }
  const parsed = parseNodeReleaseVersion(version);
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
      ? "openclaw requires Bun 1.4 or newer with WAL-reset-safe node:sqlite (SQLite 3.51.3+ or a patched 3.50.x/3.44.x release)."
      : "openclaw requires Node >=22.22.3 <23, >=24.15.0 <25, or >=25.9.0.";
  const retryHint =
    details.kind === "bun"
      ? "Upgrade Bun or run OpenClaw with a supported Node release."
      : "Upgrade Node and re-run openclaw.";

  runtime.error(
    [
      requirement,
      `Detected: ${runtimeLabel} (exec: ${execLabel}).`,
      ...(details.kind === "bun"
        ? [`Detected SQLite: ${details.sqliteVersion ?? "unavailable"}.`]
        : []),
      `PATH searched: ${details.pathEnv}`,
      details.kind === "bun"
        ? "Install Bun: https://bun.com/docs/installation"
        : "Install Node: https://nodejs.org/en/download",
      retryHint,
    ].join("\n"),
  );
  runtime.exit(1);
}
