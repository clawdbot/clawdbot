import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { WorkerProviderError, type WorkerProfile } from "openclaw/plugin-sdk/plugin-entry";

const PROFILE_KEYS = new Set(["binary", "class", "idleTimeout", "provider", "setup", "ttl"]);
const GO_DURATION_PATTERN = /^\+?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:ns|us|µs|μs|ms|s|m|h))+$/u;
const GO_DURATION_TOKEN_PATTERN = /(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|μs|ms|s|m|h)/gu;
const MAX_GO_DURATION_NANOSECONDS = 9_223_372_036_854_775_807n;
const DURATION_UNIT_NANOSECONDS: Readonly<Record<string, bigint>> = {
  h: 3_600_000_000_000n,
  m: 60_000_000_000n,
  s: 1_000_000_000n,
  ms: 1_000_000n,
  us: 1_000n,
  µs: 1_000n,
  μs: 1_000n,
  ns: 1n,
};

type CrabboxProfile = {
  binary?: string;
  class: string;
  idleTimeout: string;
  provider: string;
  ttl: string;
  setup?: string;
};

type IsExecutable = (candidate: string) => boolean;

export function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function requirePositiveDuration(value: unknown, key: string): string {
  const duration = nonEmptyString(value);
  if (!duration || !isPositiveGoDuration(duration)) {
    throw new WorkerProviderError(
      `Crabbox profile ${key} must be a positive Go duration such as 60m`,
    );
  }
  return duration;
}

function isPositiveGoDuration(duration: string): boolean {
  if (!GO_DURATION_PATTERN.test(duration)) {
    return false;
  }
  let total = 0n;
  for (const match of duration.matchAll(GO_DURATION_TOKEN_PATTERN)) {
    const numberText = match[1];
    const unit = match[2] ? DURATION_UNIT_NANOSECONDS[match[2]] : undefined;
    if (!numberText || unit === undefined) {
      return false;
    }
    const [wholeText = "", fractionText = ""] = numberText.split(".", 2);
    const whole = wholeText.replace(/^0+/u, "") || "0";
    if (whole.length > 19) {
      return false;
    }
    total += BigInt(whole) * unit;
    const fraction = fractionText.slice(0, 18);
    if (fraction) {
      total += (BigInt(fraction) * unit) / 10n ** BigInt(fraction.length);
    }
    if (total > MAX_GO_DURATION_NANOSECONDS) {
      return false;
    }
  }
  return total > 0n;
}

export function parseCrabboxProfile(profile: WorkerProfile): CrabboxProfile {
  for (const key of Object.keys(profile)) {
    if (!PROFILE_KEYS.has(key)) {
      throw new WorkerProviderError(`unknown Crabbox profile setting: ${key}`);
    }
  }

  const provider = nonEmptyString(profile.provider)?.toLowerCase();
  const machineClass = nonEmptyString(profile.class);
  if (!provider) {
    throw new WorkerProviderError("Crabbox profile provider must be a non-empty string");
  }
  if (!machineClass) {
    throw new WorkerProviderError("Crabbox profile class must be a non-empty string");
  }
  const ttl = requirePositiveDuration(profile.ttl, "ttl");
  const idleTimeout = requirePositiveDuration(profile.idleTimeout, "idleTimeout");
  const binaryValue = profile.binary;
  const binary = binaryValue === undefined ? undefined : nonEmptyString(binaryValue);
  if (binaryValue !== undefined && !binary) {
    throw new WorkerProviderError("Crabbox profile binary must be a non-empty string");
  }
  if (binary && !path.isAbsolute(binary)) {
    throw new WorkerProviderError("Crabbox profile binary must be an absolute path");
  }
  const setupValue = profile.setup;
  const setup = setupValue === undefined ? undefined : nonEmptyString(setupValue);
  if (setupValue !== undefined && !setup) {
    throw new WorkerProviderError("Crabbox profile setup must be a non-empty command string");
  }
  return { binary, class: machineClass, idleTimeout, provider, setup, ttl };
}

function defaultIsExecutable(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) {
      return false;
    }
    fs.accessSync(candidate, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function binaryCandidates(base: string, platform: NodeJS.Platform): string[] {
  return platform === "win32"
    ? [".exe", ".cmd", ".bat", ".com", ""].map((suffix) => `${base}${suffix}`)
    : [base];
}

export function resolveCrabboxBinary(params: {
  explicit?: string;
  isExecutable?: IsExecutable;
  openclawRoot: string;
  pathEnv?: string;
  platform?: NodeJS.Platform;
}): string {
  if (params.explicit) {
    return params.explicit;
  }
  const platform = params.platform ?? process.platform;
  const isExecutable =
    params.isExecutable ?? ((candidate) => defaultIsExecutable(candidate, platform));
  const siblingBase = path.resolve(params.openclawRoot, "../crabbox/bin/crabbox");
  for (const candidate of binaryCandidates(siblingBase, platform)) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  const delimiter = platform === "win32" ? ";" : ":";
  const executableNames = binaryCandidates("crabbox", platform);
  for (const directory of (params.pathEnv ?? "").split(delimiter)) {
    if (!directory) {
      continue;
    }
    for (const name of executableNames) {
      const candidate = path.resolve(directory, name);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return "crabbox";
}

export function resolveOpenClawRoot(pluginRoot: string | undefined): string {
  if (!pluginRoot) {
    return process.cwd();
  }
  const extensionsDir = path.dirname(pluginRoot);
  if (path.basename(extensionsDir) !== "extensions") {
    return process.cwd();
  }
  const extensionParent = path.dirname(extensionsDir);
  return path.basename(extensionParent) === "dist" ||
    path.basename(extensionParent) === "dist-runtime"
    ? path.dirname(extensionParent)
    : extensionParent;
}

export function operationSlug(operationId: string): string {
  return `openclaw-${createHash("sha256").update(operationId).digest("hex").slice(0, 32)}`;
}

export function identityRefId(leaseId: string): string {
  return `/leases/${leaseId}/identity`;
}
