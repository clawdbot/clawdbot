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
import { parseInspectJson, type ParsedInspect } from "./crabbox-worker-inspect.js";
import {
  identityRefId,
  nonEmptyString,
  operationSlug,
  parseCrabboxProfile,
  resolveCrabboxBinary,
} from "./crabbox-worker-profile.js";

export { resolveOpenClawRoot } from "./crabbox-worker-profile.js";

const CRABBOX_WORKER_PROVIDER_ID = "crabbox";
const CRABBOX_KEY_REF_PROVIDER = "crabbox";

const WARMUP_TIMEOUT_MS = 240_000;
const LIFECYCLE_TIMEOUT_MS = 60_000;
const PROVISION_TIMEOUT_MS = 290_000;
// Setup gets its own budget on top of provision so a slow warmup cannot starve it.
const SETUP_TIMEOUT_MS = 300_000;
const READY_POLL_INTERVAL_MS = 2_000;
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
const LEASE_ID_PATTERN = /^(?:cbx_|tbx_)[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const LEASE_TOKEN_IN_OUTPUT_PATTERN = /^leased\s+(\S{1,128})(?=\s|$)/mu;

type CrabboxCommandRunner = typeof runCommandWithTimeout;

type LeaseCommandContext = {
  binary: string;
  id: string;
  provider: string;
};

type InspectCommandResult = { status: "found"; inspect: ParsedInspect } | { status: "unknown" };

class InvalidInspectResultError extends Error {}

type CrabboxWorkerProviderDependencies = {
  isExecutable?: (candidate: string) => boolean;
  openclawRoot?: string;
  pathEnv?: string;
  platform?: NodeJS.Platform;
  runCommand?: CrabboxCommandRunner;
  sleep?: (milliseconds: number) => Promise<void>;
};

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

function permanentCommandError(action: string, result: SpawnResult): WorkerProviderError {
  return new WorkerProviderError(commandError(action, result).message);
}

async function assertAwsWorkerHasNoInstanceProfile(params: {
  binary: string;
  runCommand: CrabboxCommandRunner;
}): Promise<void> {
  const result = await runCrabboxCommand({
    action: "config show",
    args: ["config", "show", "--json"],
    binary: params.binary,
    runCommand: params.runCommand,
    timeoutMs: LIFECYCLE_TIMEOUT_MS,
  });
  if (result.termination !== "exit" || result.code !== 0) {
    throw permanentCommandError("config show", result);
  }
  let instanceProfile: unknown;
  try {
    const config: unknown = JSON.parse(result.stdout);
    instanceProfile =
      config && typeof config === "object" && !Array.isArray(config)
        ? (config as { aws?: { instanceProfile?: unknown } }).aws?.instanceProfile
        : undefined;
  } catch {
    throw new WorkerProviderError("Crabbox config show returned invalid JSON");
  }
  if (typeof instanceProfile !== "string") {
    throw new WorkerProviderError("Crabbox config show returned an invalid AWS instance profile");
  }
  if (nonEmptyString(instanceProfile)) {
    throw new WorkerProviderError("Crabbox AWS instance profile must be empty for cloud workers");
  }
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
    args: [
      "inspect",
      "--provider",
      params.context.provider,
      "--network",
      "public",
      "--id",
      params.id,
      "--json",
    ],
    binary: params.context.binary,
    runCommand: params.runCommand,
    timeoutMs: params.timeoutMs ?? LIFECYCLE_TIMEOUT_MS,
  });
  if (result.termination === "exit" && result.code === 0) {
    try {
      const inspect = parseInspectJson(result.stdout);
      if (params.expectedLeaseId && inspect.id !== params.expectedLeaseId) {
        throw new Error("Crabbox inspect returned a different lease id");
      }
      return { status: "found", inspect };
    } catch (error) {
      throw new InvalidInspectResultError(
        error instanceof Error ? error.message : "Crabbox inspect returned invalid output",
      );
    }
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
    assertProvisionSecurityPolicy(params);
    return leaseFromInspect(params.inspect);
  } catch (error) {
    await stopProvisionInspect(params);
    throw error;
  }
}

function assertProvisionSecurityPolicy(params: { inspect: ParsedInspect; provider: string }): void {
  if (params.inspect.tailscaleEnabled) {
    throw new WorkerProviderError("Crabbox cloud worker lease must not have Tailscale enabled");
  }
  if (params.provider === "aws" && params.inspect.awsInstanceProfileAttached !== false) {
    throw new WorkerProviderError(
      "Crabbox AWS inspect must attest that no instance profile is attached",
    );
  }
}

async function waitForProvisionReady(params: {
  binary: string;
  deadline: number;
  inspect: ParsedInspect;
  provider: string;
  runCommand: CrabboxCommandRunner;
  sleep: (milliseconds: number) => Promise<void>;
}): Promise<ParsedInspect> {
  let inspect = params.inspect;
  try {
    // Credential and private-network attestation is authoritative before SSH readiness.
    // Reject immediately so a forbidden lease cannot remain live during polling.
    assertProvisionSecurityPolicy({ inspect, provider: params.provider });
    while (inspect.ready !== true && !isUnusableProvisionState(inspect.state)) {
      const remaining = remainingProvisionTimeout(params.deadline, LIFECYCLE_TIMEOUT_MS);
      await params.sleep(Math.min(READY_POLL_INTERVAL_MS, remaining));
      const replay = await inspectWithContext({
        context: { binary: params.binary, provider: params.provider },
        expectedLeaseId: inspect.id,
        id: inspect.id,
        runCommand: params.runCommand,
        timeoutMs: remainingProvisionTimeout(params.deadline, LIFECYCLE_TIMEOUT_MS),
      });
      if (replay.status === "unknown") {
        throw new Error("Crabbox operation lease disappeared while waiting for SSH readiness");
      }
      inspect = replay.inspect;
      assertProvisionSecurityPolicy({ inspect, provider: params.provider });
    }
    if (isUnusableProvisionState(inspect.state)) {
      throw new Error("Crabbox operation lease entered a terminal state while waiting for SSH");
    }
    return inspect;
  } catch (error) {
    await stopProvisionInspect({ ...params, inspect });
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
  let result: SpawnResult;
  try {
    result = await runCrabboxCommand({
      action: "setup",
      args: [
        "run",
        "--provider",
        params.provider,
        "--network",
        "public",
        "--tailscale=false",
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
  } catch (error) {
    await stopProvisionInspect(params);
    throw error;
  }
  if (result.termination === "exit" && result.code === 0) {
    return;
  }
  const error = permanentCommandError("setup", result);
  await stopProvisionInspect(params);
  throw error;
}

async function stopProvisionInspect(params: {
  binary: string;
  deadline: number;
  inspect: ParsedInspect;
  provider: string;
  runCommand: CrabboxCommandRunner;
}): Promise<void> {
  await stopProvisionId({ ...params, id: params.inspect.id });
}

async function stopProvisionId(params: {
  binary: string;
  id: string;
  provider: string;
  runCommand: CrabboxCommandRunner;
}): Promise<void> {
  await stopWithContext({
    context: { binary: params.binary, id: params.id, provider: params.provider },
    runCommand: params.runCommand,
    // Cleanup gets its own budget so an exhausted provision deadline cannot leak a lease.
    timeoutMs: LIFECYCLE_TIMEOUT_MS,
  });
}

export function createCrabboxWorkerProvider(
  dependencies: CrabboxWorkerProviderDependencies = {},
): WorkerProvider {
  const runCommand = dependencies.runCommand ?? runCommandWithTimeout;
  const sleep =
    dependencies.sleep ??
    ((milliseconds) =>
      new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      }));
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
    const parsed = parseCrabboxProfile(lease.profile);
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
      const parsed = parseCrabboxProfile(profile);
      const deadline = Date.now() + PROVISION_TIMEOUT_MS;
      const setupDeadline = deadline + (parsed.setup ? SETUP_TIMEOUT_MS : 0);
      if (!operationId.trim()) {
        throw new Error("Crabbox provision requires an operation id");
      }
      const binary = resolveBinary(parsed.binary);
      const context = { binary, provider: parsed.provider };
      const slug = operationSlug(operationId);

      // Crabbox suffixes colliding slugs. Probe the deterministic operation slug first so a
      // replay after a lost warmup reply adopts the allocated lease instead of duplicating it.
      let existing: InspectCommandResult;
      try {
        existing = await inspectWithContext({
          classifyProfileErrors: true,
          context,
          id: slug,
          runCommand,
          timeoutMs: remainingProvisionTimeout(deadline, LIFECYCLE_TIMEOUT_MS),
        });
      } catch (error) {
        if (error instanceof InvalidInspectResultError) {
          // `stop` accepts the same lease-id-or-slug selector as `inspect`. Fail closed when
          // replay output cannot be attested, or the resource would survive an unusable reply.
          await stopProvisionId({ binary, id: slug, provider: parsed.provider, runCommand });
        }
        throw error;
      }
      if (parsed.provider === "aws") {
        try {
          await assertAwsWorkerHasNoInstanceProfile({ binary, runCommand });
        } catch (error) {
          // A replay lease predates the current config check. Remove it before rejecting the
          // profile so an unreturned, credential-bearing worker cannot survive the retry.
          if (existing.status === "found") {
            await stopProvisionInspect({
              binary,
              deadline,
              inspect: existing.inspect,
              provider: parsed.provider,
              runCommand,
            });
          }
          throw error;
        }
      }
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
          existingParams.inspect = await waitForProvisionReady({ ...existingParams, sleep });
          const lease = await leaseFromProvisionInspect(existingParams);
          if (parsed.setup) {
            existingParams.deadline = setupDeadline;
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
          "--network",
          "public",
          "--tailscale=false",
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
        // Warmup succeeded, so the deterministic slug is the only owned selector left.
        // Release it before rejecting output that cannot identify the retained lease.
        await stopProvisionId({ binary, id: slug, provider: parsed.provider, runCommand });
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
      let inspected: InspectCommandResult;
      try {
        inspected = await inspectWithContext({
          context,
          expectedLeaseId: allocatedId,
          id: allocatedId,
          runCommand,
          timeoutMs: remainingProvisionTimeout(deadline, LIFECYCLE_TIMEOUT_MS),
        });
      } catch (error) {
        // Warmup returned an owned lease id. Any failed inspection must release that lease;
        // callers cannot destroy a resource they never received.
        await stopProvisionId({ binary, id: allocatedId, provider: parsed.provider, runCommand });
        throw error;
      }
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
      inspectedParams.inspect = await waitForProvisionReady({ ...inspectedParams, sleep });
      const lease = await leaseFromProvisionInspect(inspectedParams);
      if (parsed.setup) {
        inspectedParams.deadline = setupDeadline;
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
