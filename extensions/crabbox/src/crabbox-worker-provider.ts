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
import {
  crabboxCommandError,
  permanentCrabboxCommandError,
} from "./crabbox-worker-command-error.js";
import * as workerDesktop from "./crabbox-worker-desktop-setup.js";
import { parseInspectJson, type ParsedInspect } from "./crabbox-worker-inspect.js";
import {
  buildCrabboxWarmupArgs,
  identityRefId,
  nonEmptyString,
  operationLeaseId,
  operationSlug,
  parseCrabboxProfile,
  resolveCrabboxBinary,
} from "./crabbox-worker-profile.js";
import {
  countCrabboxProvisionSetupPhases,
  CRABBOX_DESKTOP_WARMUP_TIMEOUT_MS,
  CRABBOX_LIFECYCLE_TIMEOUT_MS,
  CRABBOX_SETUP_TIMEOUT_MS,
  CRABBOX_WARMUP_TIMEOUT_MS,
  resolveCrabboxProvisionBaseTimeoutMs,
  resolveCrabboxProvisionCallTimeoutMs,
} from "./crabbox-worker-timeouts.js";

export { resolveOpenClawRoot } from "./crabbox-worker-profile.js";

const CRABBOX_WORKER_PROVIDER_ID = "crabbox";
const CRABBOX_KEY_REF_PROVIDER = "crabbox";

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
const LEGACY_PROVISION_OPERATION_ID_PATTERN = /^provision:[a-f0-9]{64}$/u;

type CrabboxCommandRunner = typeof runCommandWithTimeout;
type CrabboxProfile = ReturnType<typeof parseCrabboxProfile>;

type LeaseCommandContext = { binary: string; id: string; provider: string };
type ProvisionInspectContext = Omit<LeaseCommandContext, "id"> & {
  deadline: number;
  inspect: ParsedInspect;
  profile: CrabboxProfile;
  runCommand: CrabboxCommandRunner;
};

type InspectCommandResult = { status: "found"; inspect: ParsedInspect } | { status: "unknown" };

type CrabboxWorkerProviderDependencies = {
  isExecutable?: (candidate: string) => boolean;
  openclawRoot?: string;
  pathEnv?: string;
  platform?: NodeJS.Platform;
  runCommand?: CrabboxCommandRunner;
  sleep?: (milliseconds: number) => Promise<void>;
};

async function assertAwsWorkerHasNoInstanceProfile(params: {
  binary: string;
  runCommand: CrabboxCommandRunner;
}): Promise<void> {
  const result = await runCrabboxCommand({
    action: "config show",
    args: ["config", "show", "--json"],
    binary: params.binary,
    runCommand: params.runCommand,
    timeoutMs: CRABBOX_LIFECYCLE_TIMEOUT_MS,
  });
  if (result.termination !== "exit" || result.code !== 0) {
    throw permanentCrabboxCommandError("config show", result);
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
  if (result.termination !== "exit") {
    return undefined;
  }
  const output = `${result.stderr}\n${result.stdout}`;
  if (
    /\bprovider=\S+\s+does not support fixed idempotent lease IDs\b/u.test(output) ||
    /(?:unknown|unrecognized) (?:flag|option)[^\r\n]*--lease-id/iu.test(output) ||
    /flag provided but not defined:\s*-lease-id/iu.test(output)
  ) {
    return new WorkerProviderError(
      "Crabbox 0.41.1 or newer with fixed lease ID support is required",
    );
  }
  if (
    /\blease_id_conflict\b/u.test(output) &&
    !/\bretry after provider inventory converges\b/iu.test(output)
  ) {
    return permanentCrabboxCommandError("warmup", result);
  }
  if (result.code !== 2) {
    return undefined;
  }
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
    timeoutMs: params.timeoutMs ?? CRABBOX_LIFECYCLE_TIMEOUT_MS,
  });
  if (result.termination === "exit" && result.code === 0) {
    // A successful but malformed response cannot attest the fixed lease. Command failures and
    // authoritative absence remain transient so Gateway replay can inspect the live lease later.
    let inspect: ParsedInspect;
    try {
      inspect = parseInspectJson(result.stdout);
    } catch (error) {
      throw new WorkerProviderError(
        error instanceof Error ? error.message : "Crabbox inspect returned invalid output",
      );
    }
    if (params.expectedLeaseId && inspect.id !== params.expectedLeaseId) {
      throw new WorkerProviderError("Crabbox inspect returned a different lease id");
    }
    return { status: "found", inspect };
  }
  if (result.termination === "exit" && authoritativeLeaseAbsence(result, params.id)) {
    return { status: "unknown" };
  }
  throw crabboxCommandError("inspect", result);
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
    timeoutMs: params.timeoutMs ?? CRABBOX_LIFECYCLE_TIMEOUT_MS,
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
  throw crabboxCommandError("stop", result);
}

const isTerminalState = (state: string) => DESTROYED_STATES.has(state.toLowerCase());
const isUnusableProvisionState = (state: string) =>
  UNUSABLE_PROVISION_STATES.has(state.toLowerCase());

function leaseFromInspect(inspect: ParsedInspect, profile: CrabboxProfile): WorkerLease {
  if (isTerminalState(inspect.state)) {
    throw new WorkerProviderError("Crabbox operation lease is no longer active");
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
      fallbackPorts: inspect.sshFallbackPorts,
      user: inspect.sshUser,
      hostKey: requireHostKey(inspect.sshHostKey),
      keyRef: {
        source: "file",
        provider: CRABBOX_KEY_REF_PROVIDER,
        id: identityRefId(inspect.id),
      },
    },
    // Crabbox's Linux desktop contract is TigerVNC on worker loopback with a per-lease
    // password file. This warm-time capability cannot be retrofitted onto an existing lease.
    ...(profile.desktop
      ? { desktop: workerDesktop.createCrabboxWorkerDesktopEndpoint(inspect.sshUser) }
      : {}),
  };
}

async function leaseFromProvisionInspect(params: ProvisionInspectContext): Promise<WorkerLease> {
  try {
    assertProvisionSecurityPolicy(params);
    return leaseFromInspect(params.inspect, params.profile);
  } catch (error) {
    // Fixed IDs are single-use: only a permanent unusable result may tombstone this lease.
    if (error instanceof WorkerProviderError) {
      await stopProvisionInspect(params);
    }
    throw error;
  }
}

function assertProvisionSecurityPolicy(params: { inspect: ParsedInspect; provider: string }): void {
  if (params.inspect.tailscaleEnabled) {
    throw new WorkerProviderError("Crabbox cloud worker lease must not have Tailscale enabled");
  }
  const attached = params.inspect.awsInstanceProfileAttached;
  const pending = !params.inspect.ready && !isUnusableProvisionState(params.inspect.state);
  if (params.provider === "aws" && attached !== false && (attached || !pending)) {
    throw new WorkerProviderError(
      "Crabbox AWS inspect must attest that no instance profile is attached",
    );
  }
}

async function waitForProvisionReady(
  params: ProvisionInspectContext & {
    refresh?: boolean;
    sleep: (milliseconds: number) => Promise<void>;
  },
): Promise<ParsedInspect> {
  let inspect = params.inspect;
  const inspectAgain = async (): Promise<ParsedInspect> => {
    const replay = await inspectWithContext({
      context: { binary: params.binary, provider: params.provider },
      expectedLeaseId: inspect.id,
      id: inspect.id,
      runCommand: params.runCommand,
      timeoutMs: remainingProvisionTimeout(params.deadline, CRABBOX_LIFECYCLE_TIMEOUT_MS),
    });
    if (replay.status === "unknown") {
      throw new Error("Crabbox operation lease disappeared while waiting for SSH readiness");
    }
    return replay.inspect;
  };
  try {
    inspect = params.refresh ? await inspectAgain() : params.inspect;
    // Reject forbidden state immediately; omitted AWS metadata is pending only until ready.
    assertProvisionSecurityPolicy({ inspect, provider: params.provider });
    while (inspect.ready !== true && !isUnusableProvisionState(inspect.state)) {
      const remaining = remainingProvisionTimeout(params.deadline, CRABBOX_LIFECYCLE_TIMEOUT_MS);
      await params.sleep(Math.min(READY_POLL_INTERVAL_MS, remaining));
      inspect = await inspectAgain();
      assertProvisionSecurityPolicy({ inspect, provider: params.provider });
    }
    if (isUnusableProvisionState(inspect.state)) {
      throw new WorkerProviderError(
        "Crabbox operation lease entered a terminal state while waiting for SSH",
      );
    }
    return inspect;
  } catch (error) {
    if (error instanceof WorkerProviderError) {
      await stopProvisionInspect({ ...params, inspect });
    }
    throw error;
  }
}

// Setup runs on every provision attempt (including replay adoption), so commands
// must be idempotent. A failed setup stops the lease before surfacing the error;
// otherwise the caller cannot release a box it never learned about.
async function runProvisionSetup(
  params: ProvisionInspectContext & { setup: string },
): Promise<void> {
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
      timeoutMs: remainingProvisionTimeout(params.deadline, CRABBOX_SETUP_TIMEOUT_MS),
    });
  } catch (error) {
    await stopProvisionInspect(params);
    throw error;
  }
  if (result.termination === "exit" && result.code === 0) {
    return;
  }
  const error = permanentCrabboxCommandError("setup", result);
  await stopProvisionInspect(params);
  throw error;
}

async function runProvisionSetupAndWaitReady(
  params: ProvisionInspectContext & {
    setup: string;
    sleep: (milliseconds: number) => Promise<void>;
  },
): Promise<ParsedInspect> {
  await runProvisionSetup(params);
  // Setup may restart SSH or change its endpoint. Re-read the authoritative lease before
  // returning any endpoint or security attestation to core bootstrap.
  return await waitForProvisionReady({ ...params, refresh: true });
}

async function stopProvisionInspect(params: ProvisionInspectContext): Promise<void> {
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
    timeoutMs: CRABBOX_LIFECYCLE_TIMEOUT_MS,
  });
}

function transientAwsProfileCleanupError(
  profileError: WorkerProviderError,
  action: "inspect" | "stop",
  cleanupError: unknown,
): Error {
  const cleanupDetail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
  const message = `Crabbox AWS profile rejection cleanup is indeterminate during ${action}: ${cleanupDetail}; rejection: ${profileError.message}`;
  return new Error(
    truncateUtf16Safe(redactSensitiveText(message).replace(/\s+/gu, " "), MAX_ERROR_DETAIL_CHARS),
    { cause: cleanupError },
  );
}

async function rejectAwsProfileAfterLeaseReconciliation(
  context: LeaseCommandContext,
  profileError: WorkerProviderError,
  runCommand: CrabboxCommandRunner,
): Promise<never> {
  let inspected: InspectCommandResult | undefined;
  let invalidInspect: WorkerProviderError | undefined;
  try {
    inspected = await inspectWithContext({
      context,
      expectedLeaseId: context.id,
      id: context.id,
      runCommand,
    });
  } catch (error) {
    if (!(error instanceof WorkerProviderError)) {
      throw transientAwsProfileCleanupError(profileError, "inspect", error);
    }
    invalidInspect = error;
  }
  if (!invalidInspect && inspected?.status === "unknown") {
    throw profileError;
  }
  try {
    await stopWithContext({ context, runCommand });
  } catch (error) {
    const detail = invalidInspect
      ? new AggregateError([invalidInspect, error], "invalid inspect and stop failed")
      : error;
    throw transientAwsProfileCleanupError(profileError, "stop", detail);
  }
  throw profileError;
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
    resolveProvisionTimeoutMs(profile) {
      return resolveCrabboxProvisionCallTimeoutMs(parseCrabboxProfile(profile));
    },
    async provision(profile: WorkerProfile, operationId: string): Promise<WorkerLease> {
      const parsed = parseCrabboxProfile(profile);
      const warmupTimeoutMs = parsed.desktop
        ? CRABBOX_DESKTOP_WARMUP_TIMEOUT_MS
        : CRABBOX_WARMUP_TIMEOUT_MS;
      const deadline = Date.now() + resolveCrabboxProvisionBaseTimeoutMs(parsed);
      const setupCount = countCrabboxProvisionSetupPhases(parsed);
      const setupDeadline = deadline + setupCount * CRABBOX_SETUP_TIMEOUT_MS;
      if (!operationId.trim()) {
        throw new Error("Crabbox provision requires an operation id");
      }
      if (LEGACY_PROVISION_OPERATION_ID_PATTERN.test(operationId)) {
        throw new WorkerProviderError(
          "Legacy Crabbox provision state cannot be replayed safely; clean up any prior lease and dispatch again",
        );
      }
      const binary = resolveBinary(parsed.binary);
      const context = { binary, provider: parsed.provider };
      const leaseId = operationLeaseId(operationId);
      const slug = operationSlug(operationId);
      if (parsed.provider === "aws") {
        try {
          await assertAwsWorkerHasNoInstanceProfile({ binary, runCommand });
        } catch (error) {
          if (!(error instanceof WorkerProviderError)) {
            throw error;
          }
          await rejectAwsProfileAfterLeaseReconciliation(
            { binary, id: leaseId, provider: parsed.provider },
            error,
            runCommand,
          );
        }
      }

      const warmup = await runCrabboxCommand({
        action: "warmup",
        args: buildCrabboxWarmupArgs(parsed, leaseId, slug),
        binary,
        runCommand,
        timeoutMs: remainingProvisionTimeout(deadline, warmupTimeoutMs),
      });
      if (warmup.termination !== "exit" || warmup.code !== 0) {
        const profileError = provisionProfileError(warmup);
        if (profileError) {
          throw profileError;
        }
        throw crabboxCommandError("warmup", warmup);
      }
      let inspected: InspectCommandResult;
      try {
        inspected = await inspectWithContext({
          context,
          expectedLeaseId: leaseId,
          id: leaseId,
          runCommand,
          timeoutMs: remainingProvisionTimeout(deadline, CRABBOX_LIFECYCLE_TIMEOUT_MS),
        });
      } catch (error) {
        // Transport failure after warmup is indeterminate; preserve the lease for durable replay.
        if (error instanceof WorkerProviderError) {
          await stopProvisionId({ binary, id: leaseId, provider: parsed.provider, runCommand });
        }
        throw error;
      }
      if (inspected.status === "unknown") {
        throw new Error("Crabbox warmup lease was not found during inspection");
      }
      const inspectedParams = {
        binary,
        deadline,
        inspect: inspected.inspect,
        profile: parsed,
        provider: parsed.provider,
        runCommand,
      };
      if (isUnusableProvisionState(inspected.inspect.state)) {
        await stopProvisionInspect(inspectedParams);
        throw new WorkerProviderError("Crabbox warmup lease entered a terminal state");
      }
      inspectedParams.inspect = await waitForProvisionReady({ ...inspectedParams, sleep });
      inspectedParams.deadline = setupDeadline;
      inspectedParams.inspect = await workerDesktop.provisionCrabboxWorkerDesktop(
        parsed.desktop === true,
        inspectedParams.inspect.sshUser ?? "",
        inspectedParams.inspect,
        () => stopProvisionInspect(inspectedParams),
        (setup) =>
          runProvisionSetupAndWaitReady({
            ...inspectedParams,
            setup,
            sleep,
          }),
      );
      if (parsed.setup) {
        inspectedParams.inspect = await runProvisionSetupAndWaitReady({
          ...inspectedParams,
          setup: parsed.setup,
          sleep,
        });
      }
      return await leaseFromProvisionInspect(inspectedParams);
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
      // `ready` is an SSH probe; every recognized nonterminal lease remains active.
      return { status: isTerminalState(inspected.inspect.state) ? "destroyed" : "active" };
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
