import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import {
  WorkerProviderError,
  type WorkerLease,
  type WorkerLeaseStatus,
  type WorkerProfile,
  type WorkerProvider,
} from "openclaw/plugin-sdk/plugin-entry";
import { runCommandWithTimeout, type SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

const CRABBOX_WORKER_PROVIDER_ID = "crabbox";
const CRABBOX_KEY_REF_PROVIDER = "crabbox";

const WARMUP_TIMEOUT_MS = 240_000;
const LIFECYCLE_TIMEOUT_MS = 60_000;
const PROVISION_TIMEOUT_MS = 290_000;
// Setup gets its own budget on top of provision so a slow warmup cannot starve it.
const SETUP_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_ERROR_DETAIL_CHARS = 512;
const MAX_HOST_KEY_LENGTH = 16_384;
const OPENSSH_HOST_KEY_TYPE_PATTERN =
  /^(?:ssh|ecdsa-sha2|sk-(?:ssh|ecdsa-sha2))-[A-Za-z0-9@._+-]+$/u;
const OPENSSH_HOST_KEY_DATA_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u;
// Only states that prove the resource is gone or stopped map to `destroyed`. Crabbox also
// treats `deleting` and `failed` as unable to become ready, but those can retain resources
// that still need an explicit stop during teardown.
const DESTROYED_STATES = new Set([
  "deleted",
  "destroyed",
  "expired",
  "missing",
  "released",
  "stopped",
  "stopped_with_code",
  "terminated",
]);
const UNUSABLE_PROVISION_STATES = new Set([...DESTROYED_STATES, "deleting", "failed"]);
const PROFILE_KEYS = new Set(["binary", "class", "idleTimeout", "provider", "setup", "ttl"]);
const CRABBOX_LEASE_TOKEN_PATTERN = /^\S{1,128}$/u;
const LEASE_ID_PATTERN = /^(?:cbx_|tbx_)[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const LEASE_TOKEN_IN_OUTPUT_PATTERN = /^leased\s+(\S{1,128})(?=\s|$)/mu;
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

export type CrabboxCommandRunner = typeof runCommandWithTimeout;

type CrabboxProfile = {
  binary?: string;
  class: string;
  idleTimeout: string;
  provider: string;
  ttl: string;
  setup?: string;
};

type CrabboxInspect = {
  host?: unknown;
  id?: unknown;
  ready?: unknown;
  sshHost?: unknown;
  sshHostKey?: unknown;
  sshKey?: unknown;
  sshPort?: unknown;
  sshUser?: unknown;
  state?: unknown;
};

type ParsedInspect = {
  host?: string;
  id: string;
  ready?: boolean;
  sshHostKey?: string;
  sshKey?: string;
  sshPort?: number;
  sshUser?: string;
  state: string;
};

type LeaseCommandContext = {
  binary: string;
  id: string;
  provider: string;
};

type InspectCommandResult = { status: "found"; inspect: ParsedInspect } | { status: "unknown" };

type IsExecutable = (candidate: string) => boolean;

type CrabboxWorkerProviderDependencies = {
  isExecutable?: IsExecutable;
  openclawRoot?: string;
  pathEnv?: string;
  platform?: NodeJS.Platform;
  runCommand?: CrabboxCommandRunner;
};

function nonEmptyString(value: unknown): string | undefined {
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

function parseProfile(profile: WorkerProfile): CrabboxProfile {
  for (const key of Object.keys(profile)) {
    if (!PROFILE_KEYS.has(key)) {
      throw new WorkerProviderError(`unknown Crabbox profile setting: ${key}`);
    }
  }

  const provider = nonEmptyString(profile.provider);
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
  if (platform !== "win32") {
    return [base];
  }
  return [".exe", ".cmd", ".bat", ".com", ""].map((suffix) => `${base}${suffix}`);
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

function operationSlug(operationId: string): string {
  return `openclaw-${createHash("sha256").update(operationId).digest("hex").slice(0, 32)}`;
}

function identityRefId(leaseId: string): string {
  return `/leases/${leaseId}/identity`;
}

function commandDetail(result: SpawnResult): string {
  const raw = (result.stderr || result.stdout).trim();
  if (!raw) {
    return "";
  }
  const compressed = redactSensitiveText(raw).replace(/\s+/gu, " ");
  const redacted = truncateUtf16Safe(compressed, MAX_ERROR_DETAIL_CHARS);
  return redacted ? `: ${redacted}` : "";
}

function commandError(action: string, result: SpawnResult): Error {
  if (result.termination !== "exit") {
    return new Error(`Crabbox ${action} did not exit normally (${result.termination})`);
  }
  const exitCode = result.code === null ? "unknown" : String(result.code);
  return new Error(`Crabbox ${action} failed with exit code ${exitCode}${commandDetail(result)}`);
}

function provisionProfileError(result: SpawnResult): WorkerProviderError | undefined {
  if (result.termination !== "exit" || result.code !== 2) {
    return undefined;
  }
  const output = `${result.stderr}\n${result.stdout}`;
  if (/\bunknown provider\s+"[^"\r\n]+"/u.test(output)) {
    return new WorkerProviderError(
      "Crabbox profile provider is not supported by this Crabbox binary",
    );
  }
  if (/\bprovider=\S+\s+does not support warmup\b/u.test(output)) {
    return new WorkerProviderError("Crabbox profile provider does not support warmup");
  }
  if (/\bprovider=\S+.*\bdoes not support status\b/u.test(output)) {
    return new WorkerProviderError("Crabbox profile provider does not support worker leases");
  }
  if (/\bprovider=\S+\s+does not expose persistent status\b/u.test(output)) {
    return new WorkerProviderError("Crabbox profile provider does not support worker leases");
  }
  if (/\bprovider=\S+\s+is one-shot; use crabbox run\b/u.test(output)) {
    return new WorkerProviderError("Crabbox profile provider is run-only");
  }
  if (/\bprovider=\S+\s+requires module source; use crabbox run --script\b/u.test(output)) {
    return new WorkerProviderError("Crabbox profile provider requires a run script");
  }
  if (/--class is not supported for provider=\S+/u.test(output)) {
    return new WorkerProviderError("Crabbox profile class is not supported by its provider");
  }
  return undefined;
}

function authoritativeLeaseAbsence(result: SpawnResult, identifier: string): boolean {
  const output = `${result.stderr}\n${result.stdout}`;
  if (!output.includes(identifier)) {
    return false;
  }
  if (
    /\b(?:access\s+denied|authentication|authorization|credentials?|forbidden|permission|token|unauthorized)\b/iu.test(
      output,
    )
  ) {
    return false;
  }
  return (
    (result.code === 4 && /\b(?:was\s+)?not found\b/iu.test(output)) ||
    (result.code === 4 && /\bno longer exists\b/iu.test(output)) ||
    (result.code === 4 &&
      /\b(?:points to|is bound to) (?:a )?missing (?:instance|sandbox)\b/iu.test(output)) ||
    (result.code === 4 && /\bdisappeared before release\b/iu.test(output)) ||
    (result.code === 4 && /\bunknown blacksmith testbox(?:\s|:)/iu.test(output)) ||
    (result.code === 4 && /\bis not claimed by Crabbox\b/iu.test(output)) ||
    (result.code === 4 &&
      /\bwandb sandbox "[^"\r\n]+" has no matching local ownership claim\b/iu.test(output)) ||
    (result.code === 5 && /\bcoder workspace "[^"\r\n]+" not found\b/iu.test(output)) ||
    /\bcoordinator GET \S*\/v1\/leases\/\S+:\s*http 404\b/iu.test(output) ||
    (result.code === 4 && /\bunknown lease(?:\s|:)/iu.test(output))
  );
}

function alreadyStopped(result: SpawnResult, identifier: string): boolean {
  const output = `${result.stderr}\n${result.stdout}`;
  return (
    output.includes(identifier) &&
    /\balready (?:destroyed|released|stopped|terminated)\b/iu.test(output)
  );
}

async function runCrabboxCommand(params: {
  action: string;
  args: string[];
  binary: string;
  runCommand: CrabboxCommandRunner;
  timeoutMs: number;
}): Promise<SpawnResult> {
  try {
    return await params.runCommand([params.binary, ...params.args], {
      timeoutMs: params.timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      killProcessTree: true,
    });
  } catch {
    throw new Error(`Crabbox ${params.action} could not start`);
  }
}

function parseInspectJson(stdout: string): ParsedInspect {
  let value: CrabboxInspect;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("inspect output is not an object");
    }
    value = parsed as CrabboxInspect;
  } catch {
    throw new Error("Crabbox inspect returned invalid JSON");
  }

  const id = nonEmptyString(value.id);
  const state = nonEmptyString(value.state)?.toLowerCase();
  if (!id || !CRABBOX_LEASE_TOKEN_PATTERN.test(id) || !state) {
    throw new Error("Crabbox inspect returned an invalid lease identity or state");
  }
  if (value.ready !== undefined && typeof value.ready !== "boolean") {
    throw new Error("Crabbox inspect returned an invalid ready state");
  }

  const sshHost = inspectString(value.sshHost, "sshHost");
  const fallbackHost = inspectString(value.host, "host");
  const host = sshHost ?? fallbackHost;
  const sshUser = inspectString(value.sshUser, "sshUser");
  const sshHostKey = inspectString(value.sshHostKey, "sshHostKey");
  const sshKey = inspectString(value.sshKey, "sshKey");
  const sshPort = inspectPort(value.sshPort);
  return {
    id,
    state,
    ...(host ? { host } : {}),
    ...(sshUser ? { sshUser } : {}),
    ...(sshHostKey ? { sshHostKey } : {}),
    ...(sshKey ? { sshKey } : {}),
    ...(sshPort ? { sshPort } : {}),
    ...(typeof value.ready === "boolean" ? { ready: value.ready } : {}),
  };
}

function inspectString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Crabbox inspect returned an invalid ${field}`);
  }
  return nonEmptyString(value);
}

function inspectPort(value: unknown): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/u.test(value))) {
    throw new Error("Crabbox inspect returned an invalid sshPort");
  }
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Crabbox inspect returned an invalid sshPort");
  }
  return port;
}

function requireHostKey(value: string): string {
  if (value.length > MAX_HOST_KEY_LENGTH || /[\r\n]/u.test(value)) {
    throw new WorkerProviderError("Crabbox inspect returned an invalid SSH host key");
  }
  const tokens = value.trim().split(/[ \t]+/u);
  const [keyType, keyData] = tokens;
  if (
    tokens.length !== 2 ||
    !OPENSSH_HOST_KEY_TYPE_PATTERN.test(keyType ?? "") ||
    !OPENSSH_HOST_KEY_DATA_PATTERN.test(keyData ?? "") ||
    (keyData?.length ?? 0) % 4 !== 0
  ) {
    throw new WorkerProviderError("Crabbox inspect returned an invalid SSH host key");
  }
  return `${keyType} ${keyData}`;
}

async function inspectWithContext(params: {
  classifyProfileErrors?: boolean;
  context: Omit<LeaseCommandContext, "id">;
  expectedLeaseId?: string;
  id: string;
  runCommand: CrabboxCommandRunner;
  timeoutMs?: number;
}): Promise<InspectCommandResult> {
  const result = await runCrabboxCommand({
    action: "inspect",
    args: ["inspect", "--provider", params.context.provider, "--id", params.id, "--json"],
    binary: params.context.binary,
    runCommand: params.runCommand,
    timeoutMs: params.timeoutMs ?? LIFECYCLE_TIMEOUT_MS,
  });
  if (result.termination === "exit" && result.code === 0) {
    const inspect = parseInspectJson(result.stdout);
    if (params.expectedLeaseId && inspect.id !== params.expectedLeaseId) {
      throw new Error("Crabbox inspect returned a different lease id");
    }
    return { status: "found", inspect };
  }
  if (result.termination === "exit" && authoritativeLeaseAbsence(result, params.id)) {
    return { status: "unknown" };
  }
  if (params.classifyProfileErrors) {
    const profileError = provisionProfileError(result);
    if (profileError) {
      throw profileError;
    }
  }
  throw commandError("inspect", result);
}

function remainingProvisionTimeout(deadline: number, maximum: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error("Crabbox provision exceeded its provider deadline");
  }
  return Math.min(maximum, remaining);
}

async function stopWithContext(params: {
  context: LeaseCommandContext;
  runCommand: CrabboxCommandRunner;
  timeoutMs?: number;
}): Promise<void> {
  const result = await runCrabboxCommand({
    action: "stop",
    args: ["stop", "--provider", params.context.provider, "--id", params.context.id],
    binary: params.context.binary,
    runCommand: params.runCommand,
    timeoutMs: params.timeoutMs ?? LIFECYCLE_TIMEOUT_MS,
  });
  if (result.termination === "exit" && result.code === 0) {
    return;
  }
  if (
    result.termination === "exit" &&
    (authoritativeLeaseAbsence(result, params.context.id) ||
      alreadyStopped(result, params.context.id))
  ) {
    return;
  }
  throw commandError("stop", result);
}

function isTerminalState(state: string): boolean {
  return DESTROYED_STATES.has(state.toLowerCase());
}

function isUnusableProvisionState(state: string): boolean {
  return UNUSABLE_PROVISION_STATES.has(state.toLowerCase());
}

function statusFromInspect(inspect: ParsedInspect): WorkerLeaseStatus {
  if (isTerminalState(inspect.state)) {
    return { status: "destroyed" };
  }
  // `ready` is a short SSH probe, not lease existence. A recognized nonterminal lease remains
  // active while it is provisioning or temporarily unreachable, even when ready is false.
  return { status: "active" };
}

function leaseFromInspect(inspect: ParsedInspect): WorkerLease {
  if (isTerminalState(inspect.state)) {
    throw new Error("Crabbox operation lease is no longer active");
  }
  if (inspect.ready !== true) {
    throw new Error("Crabbox operation lease is not ready");
  }
  if (!inspect.host || !inspect.sshUser || !inspect.sshPort || !inspect.sshKey) {
    throw new WorkerProviderError(
      "Crabbox profile provider does not expose a complete SSH worker endpoint",
    );
  }
  if (!inspect.sshHostKey) {
    throw new WorkerProviderError(
      "Crabbox inspect does not expose the SSH host key required by the worker provider contract",
    );
  }
  return {
    leaseId: inspect.id,
    ssh: {
      host: inspect.host,
      port: inspect.sshPort,
      user: inspect.sshUser,
      hostKey: requireHostKey(inspect.sshHostKey),
      keyRef: {
        source: "file",
        provider: CRABBOX_KEY_REF_PROVIDER,
        id: identityRefId(inspect.id),
      },
    },
  };
}

async function leaseFromProvisionInspect(params: {
  binary: string;
  deadline: number;
  inspect: ParsedInspect;
  provider: string;
  runCommand: CrabboxCommandRunner;
}): Promise<WorkerLease> {
  try {
    return leaseFromInspect(params.inspect);
  } catch (error) {
    if (!(error instanceof WorkerProviderError)) {
      throw error;
    }
    await stopProvisionInspect(params);
    throw error;
  }
}

// Setup runs on every provision attempt (including replay adoption), so commands
// must be idempotent. A failed setup stops the lease before surfacing the error;
// otherwise the caller cannot release a box it never learned about.
async function runProvisionSetup(params: {
  binary: string;
  deadline: number;
  inspect: ParsedInspect;
  provider: string;
  runCommand: CrabboxCommandRunner;
  setup: string;
}): Promise<void> {
  const result = await runCrabboxCommand({
    action: "setup",
    args: [
      "run",
      "--provider",
      params.provider,
      "--id",
      params.inspect.id,
      "--keep=true",
      // Workspace transfer is owned by the worker tunnel; crabbox run must not
      // rsync the gateway checkout into the box just to execute setup.
      "--no-sync",
      "--",
      "bash",
      "-lc",
      params.setup,
    ],
    binary: params.binary,
    runCommand: params.runCommand,
    timeoutMs: remainingProvisionTimeout(params.deadline, SETUP_TIMEOUT_MS),
  });
  if (result.termination === "exit" && result.code === 0) {
    return;
  }
  await stopProvisionInspect(params);
  throw commandError("setup", result);
}

async function stopProvisionInspect(params: {
  binary: string;
  deadline: number;
  inspect: ParsedInspect;
  provider: string;
  runCommand: CrabboxCommandRunner;
}): Promise<void> {
  await stopWithContext({
    context: { binary: params.binary, id: params.inspect.id, provider: params.provider },
    runCommand: params.runCommand,
    timeoutMs: remainingProvisionTimeout(params.deadline, LIFECYCLE_TIMEOUT_MS),
  });
}

export function createCrabboxWorkerProvider(
  dependencies: CrabboxWorkerProviderDependencies = {},
): WorkerProvider {
  const runCommand = dependencies.runCommand ?? runCommandWithTimeout;
  const openclawRoot = dependencies.openclawRoot ?? process.cwd();
  let defaultBinary: string | undefined;
  const resolveBinary = (explicit?: string) => {
    if (explicit) {
      return explicit;
    }
    defaultBinary ??= resolveCrabboxBinary({
      explicit,
      isExecutable: dependencies.isExecutable,
      openclawRoot,
      pathEnv: dependencies.pathEnv ?? process.env.PATH,
      platform: dependencies.platform,
    });
    return defaultBinary;
  };
  const resolveLeaseContext = (
    lease: Parameters<WorkerProvider["inspect"]>[0],
  ): LeaseCommandContext => {
    const parsed = parseProfile(lease.profile);
    if (!LEASE_ID_PATTERN.test(lease.leaseId)) {
      throw new Error("Crabbox lease id is invalid");
    }
    return {
      binary: resolveBinary(parsed.binary),
      id: lease.leaseId,
      provider: parsed.provider,
    };
  };

  return {
    id: CRABBOX_WORKER_PROVIDER_ID,
    async provision(profile: WorkerProfile, operationId: string): Promise<WorkerLease> {
      const parsed = parseProfile(profile);
      const deadline = Date.now() + PROVISION_TIMEOUT_MS + (parsed.setup ? SETUP_TIMEOUT_MS : 0);
      if (!operationId.trim()) {
        throw new Error("Crabbox provision requires an operation id");
      }
      const binary = resolveBinary(parsed.binary);
      const context = { binary, provider: parsed.provider };
      const slug = operationSlug(operationId);

      // Crabbox suffixes colliding slugs. Probe the deterministic operation slug first so a
      // replay after a lost warmup reply adopts the allocated lease instead of duplicating it.
      const existing = await inspectWithContext({
        classifyProfileErrors: true,
        context,
        id: slug,
        runCommand,
        timeoutMs: remainingProvisionTimeout(deadline, LIFECYCLE_TIMEOUT_MS),
      });
      if (existing.status === "found") {
        const existingParams = {
          binary,
          deadline,
          inspect: existing.inspect,
          provider: parsed.provider,
          runCommand,
        };
        if (!LEASE_ID_PATTERN.test(existing.inspect.id)) {
          await stopProvisionInspect(existingParams);
          throw new WorkerProviderError(
            "Crabbox profile provider returned an unsupported lease id",
          );
        }
        if (isUnusableProvisionState(existing.inspect.state)) {
          await stopProvisionInspect(existingParams);
        } else {
          const lease = await leaseFromProvisionInspect(existingParams);
          if (parsed.setup) {
            await runProvisionSetup({ ...existingParams, setup: parsed.setup });
          }
          return lease;
        }
      }

      const warmup = await runCrabboxCommand({
        action: "warmup",
        args: [
          "warmup",
          "--provider",
          parsed.provider,
          "--class",
          parsed.class,
          "--ttl",
          parsed.ttl,
          "--idle-timeout",
          parsed.idleTimeout,
          "--slug",
          slug,
          "--keep=true",
        ],
        binary,
        runCommand,
        timeoutMs: remainingProvisionTimeout(deadline, WARMUP_TIMEOUT_MS),
      });
      if (warmup.termination !== "exit" || warmup.code !== 0) {
        const profileError = provisionProfileError(warmup);
        if (profileError) {
          throw profileError;
        }
        throw commandError("warmup", warmup);
      }
      const allocatedId = `${warmup.stdout}\n${warmup.stderr}`.match(
        LEASE_TOKEN_IN_OUTPUT_PATTERN,
      )?.[1];
      if (!allocatedId) {
        throw new Error("Crabbox warmup did not return a lease id");
      }
      if (!LEASE_ID_PATTERN.test(allocatedId)) {
        await stopWithContext({
          context: { binary, id: allocatedId, provider: parsed.provider },
          runCommand,
          timeoutMs: remainingProvisionTimeout(deadline, LIFECYCLE_TIMEOUT_MS),
        });
        throw new WorkerProviderError("Crabbox profile provider returned an unsupported lease id");
      }
      const inspected = await inspectWithContext({
        context,
        expectedLeaseId: allocatedId,
        id: allocatedId,
        runCommand,
        timeoutMs: remainingProvisionTimeout(deadline, LIFECYCLE_TIMEOUT_MS),
      });
      if (inspected.status === "unknown") {
        throw new Error("Crabbox warmup lease was not found during inspection");
      }
      const inspectedParams = {
        binary,
        deadline,
        inspect: inspected.inspect,
        provider: parsed.provider,
        runCommand,
      };
      if (isUnusableProvisionState(inspected.inspect.state)) {
        await stopProvisionInspect(inspectedParams);
        throw new Error("Crabbox warmup lease entered a terminal state");
      }
      const lease = await leaseFromProvisionInspect(inspectedParams);
      if (parsed.setup) {
        await runProvisionSetup({ ...inspectedParams, setup: parsed.setup });
      }
      return lease;
    },
    async inspect(lease): Promise<WorkerLeaseStatus> {
      const context = resolveLeaseContext(lease);
      const inspected = await inspectWithContext({
        context,
        expectedLeaseId: context.id,
        id: context.id,
        runCommand,
      });
      if (inspected.status === "unknown") {
        return { status: "unknown" };
      }
      return statusFromInspect(inspected.inspect);
    },
    async resolveSshIdentity(request) {
      const context = resolveLeaseContext(request);
      if (
        request.keyRef.source !== "file" ||
        request.keyRef.provider !== CRABBOX_KEY_REF_PROVIDER ||
        request.keyRef.id !== identityRefId(context.id)
      ) {
        throw new Error("Crabbox worker identity reference does not match its lease");
      }
      const inspected = await inspectWithContext({
        context,
        expectedLeaseId: context.id,
        id: context.id,
        runCommand,
      });
      if (
        inspected.status === "unknown" ||
        isTerminalState(inspected.inspect.state) ||
        !inspected.inspect.sshKey
      ) {
        throw new Error("Crabbox inspect did not return the worker identity path");
      }
      if (!path.isAbsolute(inspected.inspect.sshKey)) {
        throw new Error("Crabbox inspect returned a non-absolute worker identity path");
      }
      return { kind: "path", path: inspected.inspect.sshKey };
    },
    async destroy(lease): Promise<void> {
      const context = resolveLeaseContext(lease);
      await stopWithContext({ context, runCommand });
    },
  };
}
