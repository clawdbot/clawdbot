import { createRequire } from "node:module";
import { normalizeOptionalString } from "./shared/string-coerce.js";

declare const __OPENCLAW_VERSION__: string | undefined;
const CORE_PACKAGE_NAME = "openclaw";

const PACKAGE_JSON_CANDIDATES = [
  "../package.json",
  "../../package.json",
  "../../../package.json",
  "./package.json",
] as const;

const BUILD_INFO_CANDIDATES = [
  "../build-info.json",
  "../../build-info.json",
  "./build-info.json",
] as const;

function readVersionFromJsonCandidates(
  moduleUrl: string,
  candidates: readonly string[],
  opts: { requirePackageName?: boolean } = {},
): string | null {
  try {
    const require = createRequire(moduleUrl);
    for (const candidate of candidates) {
      try {
        const parsed = require(candidate) as { name?: string; version?: string };
        const version = normalizeOptionalString(parsed.version);
        if (!version) {
          continue;
        }
        if (opts.requirePackageName && parsed.name !== CORE_PACKAGE_NAME) {
          continue;
        }
        return version;
      } catch {
        // ignore missing or unreadable candidate
      }
    }
    return null;
  } catch {
    return null;
  }
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = normalizeOptionalString(value);
    if (trimmed && trimmed.toLowerCase() !== "undefined" && trimmed.toLowerCase() !== "null") {
      return trimmed;
    }
  }
  return undefined;
}

export function readVersionFromPackageJsonForModuleUrl(moduleUrl: string): string | null {
  return readVersionFromJsonCandidates(moduleUrl, PACKAGE_JSON_CANDIDATES, {
    requirePackageName: true,
  });
}

export function readVersionFromBuildInfoForModuleUrl(moduleUrl: string): string | null {
  return readVersionFromJsonCandidates(moduleUrl, BUILD_INFO_CANDIDATES);
}

export function resolveVersionFromModuleUrl(moduleUrl: string): string | null {
  return (
    readVersionFromPackageJsonForModuleUrl(moduleUrl) ||
    readVersionFromBuildInfoForModuleUrl(moduleUrl)
  );
}

export function resolveBinaryVersion(params: {
  moduleUrl: string;
  injectedVersion?: string;
  bundledVersion?: string;
  fallback?: string;
}): string {
  return (
    firstNonEmpty(params.injectedVersion) ||
    resolveVersionFromModuleUrl(params.moduleUrl) ||
    firstNonEmpty(params.bundledVersion) ||
    params.fallback ||
    "0.0.0"
  );
}

export type RuntimeVersionEnv = {
  [key: string]: string | undefined;
};

export const RUNTIME_SERVICE_VERSION_FALLBACK = "unknown";
type RuntimeVersionPreference = "env-first" | "runtime-first";

export function resolveUsableRuntimeVersion(version: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(version);
  // "0.0.0" is the resolver's hard fallback when module metadata cannot be read.
  // Prefer explicit service/package markers in that edge case.
  if (!trimmed || trimmed === "0.0.0") {
    return undefined;
  }
  return trimmed;
}

function resolveVersionFromRuntimeSources(params: {
  env: RuntimeVersionEnv;
  runtimeVersion: string | undefined;
  fallback: string;
  preference: RuntimeVersionPreference;
}): string {
  const preferredCandidates =
    params.preference === "env-first"
      ? [params.env["OPENCLAW_VERSION"], params.runtimeVersion]
      : [params.runtimeVersion, params.env["OPENCLAW_VERSION"]];
  return (
    firstNonEmpty(
      ...preferredCandidates,
      params.env["OPENCLAW_SERVICE_VERSION"],
      params.env["npm_package_version"],
    ) ?? params.fallback
  );
}

export function resolveRuntimeServiceVersion(
  env: RuntimeVersionEnv = process.env as RuntimeVersionEnv,
  fallback = RUNTIME_SERVICE_VERSION_FALLBACK,
): string {
  return resolveVersionFromRuntimeSources({
    env,
    runtimeVersion: resolveUsableRuntimeVersion(VERSION),
    fallback,
    preference: "env-first",
  });
}

export function resolveCompatibilityHostVersion(
  env: RuntimeVersionEnv = process.env as RuntimeVersionEnv,
  fallback = RUNTIME_SERVICE_VERSION_FALLBACK,
): string {
  const explicitCompatibilityVersion = firstNonEmpty(env.OPENCLAW_COMPATIBILITY_HOST_VERSION);
  if (explicitCompatibilityVersion) {
    return explicitCompatibilityVersion;
  }
  return resolveVersionFromRuntimeSources({
    env,
    runtimeVersion: resolveUsableRuntimeVersion(VERSION),
    fallback,
    preference: env === (process.env as RuntimeVersionEnv) ? "runtime-first" : "env-first",
  });
}

// Single source of truth for the current OpenClaw version.
// - Embedded/bundled builds: injected define or env var.
// - Dev/npm builds: package.json.
export const VERSION = resolveBinaryVersion({
  moduleUrl: import.meta.url,
  injectedVersion: typeof __OPENCLAW_VERSION__ === "string" ? __OPENCLAW_VERSION__ : undefined,
  bundledVersion: process.env.OPENCLAW_BUNDLED_VERSION,
});
