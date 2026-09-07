import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  WorkerProviderError,
  type WorkerMachineOption,
  type WorkerProfile,
} from "openclaw/plugin-sdk/plugin-entry";
import { normalizeOptionalString as nonEmptyString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CRABBOX_HEARTBEAT_TIMEOUT_MS } from "./crabbox-worker-timeouts.js";

export { nonEmptyString };

const PROFILE_KEYS = new Set([
  "binary",
  "class",
  "desktop",
  "idleTimeout",
  "provider",
  "setup",
  "setupEnv",
  "ttl",
  "warmImage",
]);
const GO_DURATION_PATTERN = /^\+?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:ns|us|µs|μs|ms|s|m|h))+$/u;
const GO_DURATION_TOKEN_PATTERN = /(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|μs|ms|s|m|h)/gu;
const MAX_GO_DURATION_NANOSECONDS = 9_223_372_036_854_775_807n;
const CRABBOX_LEASE_ID_DOMAIN = "openclaw:crabbox-worker-lease-id:v1\0";
const LEGACY_PROVISION_OPERATION_ID_PATTERN = /^provision:[a-f0-9]{64}$/u;
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
  class?: string;
  desktop?: boolean;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  idleTimeout: string;
  provider: string;
  ttl: string;
  setup?: string;
  setupEnv?: string[];
  warmImage?: boolean;
};

const MAX_CRABBOX_MACHINE_CLASS_LENGTH = 128;
const MAX_CRABBOX_MACHINE_OPTIONS = 32;
const CRABBOX_DESKTOP_PROVIDERS = new Set(["aws", "hetzner"]);

export type CrabboxMachineShape = Readonly<{
  class: string;
  cpu?: number;
  memoryGb?: number;
}>;

type IsExecutable = (candidate: string) => boolean;

export const CRABBOX_WORKER_PROVIDER_ID = "crabbox";

function requirePositiveDuration(
  value: unknown,
  key: string,
): { duration: string; milliseconds: number } {
  const duration = nonEmptyString(value);
  const nanoseconds = duration ? parsePositiveGoDurationNanoseconds(duration) : undefined;
  if (!duration || nanoseconds === undefined) {
    throw new WorkerProviderError(
      `Crabbox profile ${key} must be a positive Go duration such as 60m`,
    );
  }
  return { duration, milliseconds: Number(nanoseconds) / 1_000_000 };
}

function parsePositiveGoDurationNanoseconds(duration: string): bigint | undefined {
  if (!GO_DURATION_PATTERN.test(duration)) {
    return undefined;
  }
  let total = 0n;
  for (const match of duration.matchAll(GO_DURATION_TOKEN_PATTERN)) {
    const numberText = match[1];
    const unit = match[2] ? DURATION_UNIT_NANOSECONDS[match[2]] : undefined;
    if (!numberText || unit === undefined) {
      return undefined;
    }
    const [wholeText = "", fractionText = ""] = numberText.split(".", 2);
    const whole = wholeText.replace(/^0+/u, "") || "0";
    if (whole.length > 19) {
      return undefined;
    }
    total += BigInt(whole) * unit;
    const fraction = fractionText.slice(0, 18);
    if (fraction) {
      total += (BigInt(fraction) * unit) / 10n ** BigInt(fraction.length);
    }
    if (total > MAX_GO_DURATION_NANOSECONDS) {
      return undefined;
    }
  }
  return total > 0n ? total : undefined;
}

function heartbeatIntervalMs(idleTimeoutMs: number): number {
  const referenceIntervalMs = Math.max(5_000, Math.min(60_000, idleTimeoutMs / 3));
  // Crabbox's floor can exceed short accepted timeouts. Keep renewal ahead of
  // coordinator idle expiry without changing the profile contract.
  return Math.min(referenceIntervalMs, Math.max(1, Math.floor(idleTimeoutMs / 2)));
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
  if (profile.class !== undefined && !machineClass) {
    throw new WorkerProviderError("Crabbox profile class must be a non-empty string");
  }
  const { duration: ttl } = requirePositiveDuration(profile.ttl, "ttl");
  const { duration: idleTimeout, milliseconds: idleTimeoutMs } = requirePositiveDuration(
    profile.idleTimeout,
    "idleTimeout",
  );
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
  let setupEnv: string[] | undefined;
  if (profile.setupEnv !== undefined) {
    if (!Array.isArray(profile.setupEnv)) {
      throw new WorkerProviderError("Crabbox profile setupEnv must be an array");
    }
    if (profile.setupEnv.length > 16) {
      throw new WorkerProviderError("Crabbox profile setupEnv must contain at most 16 names");
    }
    setupEnv = profile.setupEnv.map((name) => {
      if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
        throw new WorkerProviderError(
          "Crabbox profile setupEnv must contain only valid POSIX environment variable names",
        );
      }
      if (name === "CRABBOX_ENV_ALLOW") {
        throw new WorkerProviderError(`Crabbox profile setupEnv name ${name} is reserved`);
      }
      return name;
    });
    if (new Set(setupEnv).size !== setupEnv.length) {
      throw new WorkerProviderError("Crabbox profile setupEnv must not contain duplicate names");
    }
    if (setupEnv.length > 0 && !setup) {
      throw new WorkerProviderError("Crabbox profile setupEnv requires setup");
    }
  }
  const desktop = profile.desktop;
  if (desktop !== undefined && typeof desktop !== "boolean") {
    throw new WorkerProviderError("Crabbox profile desktop must be a boolean");
  }
  if (desktop && !CRABBOX_DESKTOP_PROVIDERS.has(provider)) {
    throw new WorkerProviderError(
      "Crabbox desktop profiles support only AWS and coordinator-backed Hetzner",
    );
  }
  const warmImage = profile.warmImage;
  if (warmImage !== undefined && typeof warmImage !== "boolean") {
    throw new WorkerProviderError("Crabbox profile warmImage must be a boolean");
  }
  return {
    binary,
    class: machineClass,
    desktop,
    heartbeatIntervalMs: heartbeatIntervalMs(idleTimeoutMs),
    heartbeatTimeoutMs: Math.min(
      CRABBOX_HEARTBEAT_TIMEOUT_MS,
      Math.max(1, Math.floor(idleTimeoutMs / 2)),
    ),
    idleTimeout,
    provider,
    setup,
    setupEnv,
    ttl,
    warmImage,
  };
}

function resolveCrabboxProfileSetupEnv(
  setupEnv: readonly string[] | undefined,
): Record<string, string> | undefined {
  if (!setupEnv?.length) {
    return undefined;
  }
  return Object.fromEntries(
    setupEnv.map((name) => {
      const value = process.env[name];
      if (!Object.hasOwn(process.env, name) || value === undefined) {
        throw new Error(`Crabbox profile setupEnv variable is missing: ${name}`);
      }
      return [name, value];
    }),
  );
}

// Resolve defaults only after sizing is known: placement and enrolled lease classes
// must share the same policy without reading setup environment values during teardown.
export function resolveCrabboxWarmImageProfile(
  profile: CrabboxProfile,
  machineClass = profile.class,
) {
  return {
    ...profile,
    class: machineClass,
    warmImage: profile.warmImage ?? (machineClass !== undefined && !profile.setupEnv?.length),
  };
}

type CrabboxProvisionProfile = CrabboxProfile &
  ({ warmImage: false } | { warmImage: true; class: string });

export function resolveCrabboxProvisionProfile(
  profile: WorkerProfile,
  requestedClassValue: unknown,
): { profile: CrabboxProvisionProfile; forwardedEnv?: Record<string, string> } {
  const configured = parseCrabboxProfile(profile);
  const requestedClass = nonEmptyString(requestedClassValue);
  if (
    requestedClassValue !== undefined &&
    (!requestedClass || requestedClass.length > MAX_CRABBOX_MACHINE_CLASS_LENGTH)
  ) {
    throw new WorkerProviderError(
      "Crabbox machine class must be a non-empty string of at most 128 characters",
    );
  }
  const resolved = resolveCrabboxWarmImageProfile(configured, requestedClass ?? configured.class);
  let provisionProfile: CrabboxProvisionProfile;
  if (!resolved.warmImage) {
    provisionProfile = { ...resolved, warmImage: false };
  } else {
    // Reject immutable sizing before mutable setup values can mask it on replay.
    if (!resolved.class) {
      throw new WorkerProviderError(
        "Crabbox warmImage requires a configured class or a placement machine class",
      );
    }
    provisionProfile = { ...resolved, class: resolved.class, warmImage: true };
  }
  return {
    profile: provisionProfile,
    forwardedEnv: resolveCrabboxProfileSetupEnv(resolved.setupEnv),
  };
}

export function listCrabboxMachineOptions(
  configuredClass: string | undefined,
  shapes: readonly CrabboxMachineShape[] = [],
): readonly WorkerMachineOption[] {
  const seen = new Set<string>();
  const candidates = shapes.filter((shape) => {
    if (shape.class.length > MAX_CRABBOX_MACHINE_CLASS_LENGTH || seen.has(shape.class)) {
      return false;
    }
    seen.add(shape.class);
    return true;
  });
  if (candidates.length === 0) {
    return [];
  }
  const catalogLimit =
    configuredClass === undefined ||
    candidates
      .slice(0, MAX_CRABBOX_MACHINE_OPTIONS)
      .some((shape) => shape.class === configuredClass)
      ? MAX_CRABBOX_MACHINE_OPTIONS
      : MAX_CRABBOX_MACHINE_OPTIONS - 1;
  const options = candidates.slice(0, catalogLimit).map((shape) => {
    const id = shape.class;
    const result: {
      id: string;
      label: string;
      cpu?: number;
      memoryGb?: number;
      default?: boolean;
    } = { id, label: id.replace(/^./u, (initial) => initial.toUpperCase()) };
    if (shape.cpu !== undefined) {
      result.cpu = shape.cpu;
    }
    if (shape.memoryGb !== undefined) {
      result.memoryGb = shape.memoryGb;
    }
    if (id === configuredClass) {
      result.default = true;
    }
    return result;
  });
  if (configuredClass !== undefined && !options.some((option) => option.id === configuredClass)) {
    options.push({
      id: configuredClass,
      label: configuredClass,
      default: true,
    });
  }
  return options;
}

export function buildCrabboxAllocationArgs(
  profile: CrabboxProfile,
  leaseId: string,
  slug: string,
): string[] {
  const args = [
    "--provider",
    profile.provider,
    "--network",
    "public",
    "--tailscale=false",
    ...(profile.class ? ["--class", profile.class] : []),
    "--ttl",
    profile.ttl,
    "--idle-timeout",
    profile.idleTimeout,
    "--lease-id",
    leaseId,
    "--slug",
    slug,
    "--keep=true",
  ];
  if (profile.desktop) {
    args.push("--desktop", "--browser", "--desktop-env", "xfce");
  }
  return args;
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
  return findCrabboxBinary(params) ?? "crabbox";
}

export function findCrabboxBinary(params: {
  explicit?: string;
  isExecutable?: IsExecutable;
  openclawRoot: string;
  pathEnv?: string;
  platform?: NodeJS.Platform;
}): string | undefined {
  const platform = params.platform ?? process.platform;
  const isExecutable =
    params.isExecutable ?? ((candidate) => defaultIsExecutable(candidate, platform));
  if (params.explicit) {
    return isExecutable(params.explicit) ? params.explicit : undefined;
  }
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
  return undefined;
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

export function operationLeaseId(operationId: string): string {
  if (!operationId.trim()) {
    throw new Error("Crabbox provision requires an operation id");
  }
  if (LEGACY_PROVISION_OPERATION_ID_PATTERN.test(operationId)) {
    // Historical random allocation can exist without a recorded handle; refusing replay
    // must not terminalize unresolved cleanup responsibility.
    throw new Error(
      "Legacy Crabbox provision state cannot be replayed safely; clean up any prior lease and dispatch again",
    );
  }
  return `cbx_${createHash("sha256")
    .update(CRABBOX_LEASE_ID_DOMAIN)
    .update(operationId)
    .digest("hex")
    .slice(0, 12)}`;
}
