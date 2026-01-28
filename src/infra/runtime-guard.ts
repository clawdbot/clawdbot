import process from "node:process";

import { defaultRuntime, type RuntimeEnv } from "../runtime.js";

export type RuntimeKind = "node" | "unknown";

type Semver = {
  major: number;
  minor: number;
  patch: number;
};

const MIN_NODE: Semver = { major: 22, minor: 0, patch: 0 };

export type RuntimeDetails = {
  kind: RuntimeKind;
  version: string | null;
  execPath: string | null;
  pathEnv: string;
};

const SEMVER_RE = /(\d+)\.(\d+)\.(\d+)/;

export function parseSemver(version: string | null): Semver | null {
  if (!version) return null;
  const match = version.match(SEMVER_RE);
  if (!match) return null;
  const [, major, minor, patch] = match;
  return {
    major: Number.parseInt(major, 10),
    minor: Number.parseInt(minor, 10),
    patch: Number.parseInt(patch, 10),
  };
}

export function isAtLeast(version: Semver | null, minimum: Semver): boolean {
  if (!version) return false;
  if (version.major !== minimum.major) return version.major > minimum.major;
  if (version.minor !== minimum.minor) return version.minor > minimum.minor;
  return version.patch >= minimum.patch;
}

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

export function runtimeSatisfies(details: RuntimeDetails): boolean {
  const parsed = parseSemver(details.version);
  if (details.kind === "node") return isAtLeast(parsed, MIN_NODE);
  return false;
}

export function isSupportedNodeVersion(version: string | null): boolean {
  return isAtLeast(parseSemver(version), MIN_NODE);
}

export function assertSupportedRuntime(
  runtime: RuntimeEnv = defaultRuntime,
  details: RuntimeDetails = detectRuntime(),
): void {
  if (runtimeSatisfies(details)) return;

  const versionLabel = details.version ?? "unknown";
  const runtimeLabel =
    details.kind === "unknown" ? "unknown runtime" : `${details.kind} ${versionLabel}`;
  const execLabel = details.execPath ?? "unknown";

  runtime.error(
    [
      "moltbot requires Node >=22.0.0.",
      `Detected: ${runtimeLabel} (exec: ${execLabel}).`,
      `PATH searched: ${details.pathEnv}`,
      "Install Node: https://nodejs.org/en/download",
      "Upgrade Node and re-run moltbot.",
    ].join("\n"),
  );
  runtime.exit(1);
}
