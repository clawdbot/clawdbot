import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import {
  WorkerProviderError,
  type WorkerLease,
  type WorkerLeaseStatus,
  type WorkerProfile,
  type WorkerProvider,
} from "openclaw/plugin-sdk/plugin-entry";
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-store-runtime";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  crabboxCommandError,
  permanentCrabboxCommandError,
} from "./crabbox-worker-command-error.js";
import {
  type CrabboxCommandRunner,
  isAuthoritativeLeaseAbsence,
  runCrabboxCommand,
  stopCrabboxLease,
} from "./crabbox-worker-command.js";
import {
  createCrabboxWorkerDesktopEndpoint,
  createCrabboxWorkerDesktopSetup,
} from "./crabbox-worker-desktop-setup.js";
import { withCrabboxWorkerEnvProfile } from "./crabbox-worker-env-profile.js";
import { createCrabboxHeartbeatManager } from "./crabbox-worker-heartbeat.js";
import { parseInspectJson, type ParsedInspect } from "./crabbox-worker-inspect.js";
import { createCrabboxMachineOptionsResolver } from "./crabbox-worker-machine-options.js";
import { collectCrabboxNodeEnrollmentEvidence } from "./crabbox-worker-node-enrollment-diagnostics.js";
import {
  createCrabboxNodeEnrollmentSetup,
  type CrabboxWorkerNodeEnrollment,
} from "./crabbox-worker-node-enrollment.js";
import {
  CRABBOX_WORKER_PROVIDER_ID,
  nonEmptyString,
  operationLeaseId,
  operationSlug,
  parseCrabboxProfile,
  resolveCrabboxBinary,
  resolveCrabboxProvisionProfile,
  resolveCrabboxWarmImageProfile,
} from "./crabbox-worker-profile.js";
import {
  countCrabboxProvisionSetupPhases,
  CRABBOX_DESKTOP_WARMUP_TIMEOUT_MS,
  CRABBOX_LIFECYCLE_TIMEOUT_MS,
  CRABBOX_MACHINE0_READY_WAIT_TIMEOUT,
  CRABBOX_NODE_ENROLLMENT_TIMEOUT_MS,
  CRABBOX_SETUP_TIMEOUT_MS,
  CRABBOX_WARMUP_TIMEOUT_MS,
  resolveCrabboxLifecycleTimeoutMs,
  resolveCrabboxProvisionBaseTimeoutMs,
  resolveCrabboxProvisionCallTimeoutMs,
  resolveCrabboxReadyPollIntervalMs,
} from "./crabbox-worker-timeouts.js";
import { loadCrabboxWorkerWallpaperBase64 } from "./crabbox-worker-wallpaper.js";
import { createCrabboxWarmImageManager } from "./crabbox-worker-warm-image.js";

export { resolveOpenClawRoot } from "./crabbox-worker-profile.js";

const MAX_ERROR_DETAIL_CHARS = 512;
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

type CrabboxProfile = ReturnType<typeof parseCrabboxProfile>;

type LeaseCommandContext = { binary: string; id: string; provider: string };
type LeaseHeartbeatContext = LeaseCommandContext &
  Pick<CrabboxProfile, "heartbeatIntervalMs" | "heartbeatTimeoutMs" | "idleTimeout">;
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
  wallpaperPath: string;
  warn?: (message: string) => void;
};

async function loadCrabboxConfigShow(params: {
  binary: string;
  runCommand: CrabboxCommandRunner;
}): Promise<unknown> {
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
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new WorkerProviderError("Crabbox config show returned invalid JSON");
  }
}

async function assertAwsWorkerHasNoInstanceProfile(params: {
  binary: string;
  runCommand: CrabboxCommandRunner;
}): Promise<void> {
  const config = await loadCrabboxConfigShow(params);
  const instanceProfile =
    config && typeof config === "object" && !Array.isArray(config)
      ? (config as { aws?: { instanceProfile?: unknown } }).aws?.instanceProfile
      : undefined;
  if (typeof instanceProfile !== "string") {
    throw new WorkerProviderError("Crabbox config show returned an invalid AWS instance profile");
  }
  if (nonEmptyString(instanceProfile)) {
    throw new WorkerProviderError("Crabbox AWS instance profile must be empty for cloud workers");
  }
}

async function assertHetznerDesktopHasManagedCoordinator(params: {
  binary: string;
  runCommand: CrabboxCommandRunner;
}): Promise<void> {
  const config = await loadCrabboxConfigShow(params);
  const view = isRecord(config) ? config : undefined;
  if (nonEmptyString(view?.coordinator) && view?.brokerMode === "managed") {
    return;
  }
  throw new WorkerProviderError("Crabbox Hetzner desktop profiles require a managed coordinator");
}

async function inspectWithContext(params: {
  context: Omit<LeaseCommandContext, "id">;
  expectedLeaseId?: string;
  id: string;
  runCommand: CrabboxCommandRunner;
  timeoutMs?: number;
  waitForReady?: boolean;
}): Promise<InspectCommandResult> {
  const action = params.waitForReady ? "status" : "inspect";
  const result = await runCrabboxCommand({
    action,
    args: [
      action,
      "--provider",
      params.context.provider,
      "--network",
      "public",
      "--id",
      params.id,
      ...(params.waitForReady
        ? ["--wait", "--wait-timeout", CRABBOX_MACHINE0_READY_WAIT_TIMEOUT]
        : []),
      "--json",
    ],
    binary: params.context.binary,
    runCommand: params.runCommand,
    timeoutMs: params.timeoutMs ?? resolveCrabboxLifecycleTimeoutMs(params.context.provider),
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
  if (result.termination === "exit" && isAuthoritativeLeaseAbsence(result, params.id)) {
    return { status: "unknown" };
  }
  throw crabboxCommandError(action, result);
}

function remainingProvisionTimeout(deadline: number, maximum: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error("Crabbox provision exceeded its provider deadline");
  }
  return Math.min(maximum, remaining);
}

const isTerminalState = (state: string) => DESTROYED_STATES.has(state.toLowerCase());
const isUnusableProvisionState = (state: string) =>
  UNUSABLE_PROVISION_STATES.has(state.toLowerCase());

function leaseRunArgs(
  context: LeaseCommandContext,
  forwardedEnvNames: readonly string[] = [],
  envProfilePath?: string,
): string[] {
  return [
    "run",
    "--provider",
    context.provider,
    "--network",
    "public",
    "--tailscale=false",
    "--id",
    context.id,
    "--keep=true",
    // Workspace transfer is owned by the worker tunnel; lease scripts must not
    // rsync the gateway checkout into the box just to execute setup or diagnostics.
    "--no-sync",
    ...forwardedEnvNames.flatMap((name) => ["--allow-env", name]),
    ...(envProfilePath ? ["--env-from-profile", envProfilePath] : []),
    "--script-stdin",
  ];
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
      timeoutMs: remainingProvisionTimeout(
        params.deadline,
        resolveCrabboxLifecycleTimeoutMs(params.provider),
      ),
      waitForReady: params.provider === "machine0",
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
      await params.sleep(Math.min(resolveCrabboxReadyPollIntervalMs(params.provider), remaining));
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
      return await failProvisionAfterCleanup({ ...params, id: inspect.id }, error);
    }
    throw error;
  }
}

// Setup runs on every provision attempt (including replay adoption), so commands
// must be idempotent. A failed setup stops the lease before surfacing the error;
// otherwise the caller cannot release a box it never learned about.
async function runProvisionSetupAndWaitReady(
  params: ProvisionInspectContext & {
    phase: string;
    setup: string;
    timeoutMs?: number;
    forwardedEnv?: Record<string, string>;
    sleep: (milliseconds: number) => Promise<void>;
  },
): Promise<ParsedInspect> {
  try {
    const result = await withCrabboxWorkerEnvProfile(
      params.forwardedEnv,
      (names, profilePath, childEnv) =>
        runCrabboxCommand({
          action: params.phase,
          args: leaseRunArgs({ ...params, id: params.inspect.id }, names, profilePath),
          binary: params.binary,
          env: childEnv,
          input: params.setup,
          runCommand: params.runCommand,
          timeoutMs: remainingProvisionTimeout(
            params.deadline,
            params.timeoutMs ?? CRABBOX_SETUP_TIMEOUT_MS,
          ),
        }),
    );
    if (result.termination !== "exit" || result.code !== 0) {
      throw permanentCrabboxCommandError(params.phase, result);
    }
  } catch (error) {
    return await failProvisionAfterCleanup({ ...params, id: params.inspect.id }, error);
  }
  // Setup may restart SSH or change its endpoint. Re-read the authoritative lease before
  // returning any endpoint or security attestation to core bootstrap.
  return await waitForProvisionReady({ ...params, refresh: true });
}

async function stopLeaseWithLifecycleTimeout(
  params: LeaseCommandContext & { runCommand: CrabboxCommandRunner },
): Promise<void> {
  await stopCrabboxLease({
    binary: params.binary,
    id: params.id,
    provider: params.provider,
    runCommand: params.runCommand,
    // Cleanup gets its own budget so an exhausted provision deadline cannot leak a lease.
    timeoutMs: resolveCrabboxLifecycleTimeoutMs(params.provider),
  });
}

async function failProvisionAfterCleanup(
  params: LeaseCommandContext & { runCommand: CrabboxCommandRunner },
  provisionError: unknown,
): Promise<never> {
  try {
    await stopLeaseWithLifecycleTimeout(params);
  } catch (cleanupError) {
    throw WorkerProviderError.cleanupIndeterminate(params.id, provisionError, cleanupError);
  }
  throw provisionError;
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
    await stopCrabboxLease({ ...context, runCommand });
  } catch (error) {
    if (!invalidInspect && inspected?.status === "found") {
      throw WorkerProviderError.cleanupIndeterminate(context.id, profileError, error);
    }
    const detail = invalidInspect
      ? new AggregateError([invalidInspect, error], "invalid inspect and stop failed")
      : error;
    throw transientAwsProfileCleanupError(profileError, "stop", detail);
  }
  throw profileError;
}

export function createCrabboxWorkerProvider(
  dependencies: CrabboxWorkerProviderDependencies,
): WorkerProvider & { dispose: () => void } {
  const wallpaperBase64 = loadCrabboxWorkerWallpaperBase64(dependencies.wallpaperPath);
  const runCommand = dependencies.runCommand ?? runCommandWithTimeout;
  const warn = dependencies.warn ?? (() => {});
  const sleep =
    dependencies.sleep ??
    ((milliseconds) =>
      new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      }));
  const openclawRoot = dependencies.openclawRoot ?? process.cwd();
  const heartbeats = createCrabboxHeartbeatManager({
    run: (context, signal) =>
      runCrabboxCommand({
        action: "heartbeat",
        args: [
          "heartbeat",
          "--provider",
          context.provider,
          "--id",
          context.id,
          "--idle-timeout",
          context.idleTimeout,
          "--json",
        ],
        binary: context.binary,
        runCommand,
        signal,
        timeoutMs: context.heartbeatTimeoutMs,
      }),
    warn,
  });
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
  const listMachineOptions = createCrabboxMachineOptionsResolver({
    resolveBinary,
    runCommand,
    warn,
  });
  const warmImages = createCrabboxWarmImageManager({ runCommand, runArgs: leaseRunArgs, warn });
  let warmLeases:
    | ReturnType<typeof createPluginStateSyncKeyedStore<{ machineClass: string }>>
    | undefined;
  const openWarmLeases = () =>
    (warmLeases ??= createPluginStateSyncKeyedStore<{ machineClass: string }>("crabbox", {
      namespace: "warm-leases",
      maxEntries: 256,
      overflowPolicy: "evict-oldest",
    }));
  const resolveLeaseContext = (
    lease: Parameters<WorkerProvider["inspect"]>[0],
  ): { context: LeaseHeartbeatContext; profile: CrabboxProfile } => {
    const profile = parseCrabboxProfile(lease.profile);
    if (!LEASE_ID_PATTERN.test(lease.leaseId)) {
      throw new Error("Crabbox lease id is invalid");
    }
    return {
      context: {
        binary: resolveBinary(profile.binary),
        heartbeatIntervalMs: profile.heartbeatIntervalMs,
        heartbeatTimeoutMs: profile.heartbeatTimeoutMs,
        id: lease.leaseId,
        idleTimeout: profile.idleTimeout,
        provider: profile.provider,
      },
      profile,
    };
  };

  return {
    id: CRABBOX_WORKER_PROVIDER_ID,
    dispose: () => heartbeats.dispose(),
    listMachineOptions,
    supportedExecutionModes: ["worker-turn", "remote-exec"],
    provisionBeforeInstallation: true,
    requiresNodeEnrollment: true,
    resolveProvisionTimeoutMs(profile) {
      return resolveCrabboxProvisionCallTimeoutMs(parseCrabboxProfile(profile));
    },
    async provision(
      profile: WorkerProfile,
      operationId: string,
      options: Parameters<WorkerProvider["provision"]>[2],
    ): Promise<WorkerLease> {
      const executionMode: unknown = options?.executionMode;
      if (
        executionMode !== undefined &&
        executionMode !== "worker-turn" &&
        executionMode !== "remote-exec"
      ) {
        throw new WorkerProviderError("Crabbox execution mode is unsupported");
      }
      const { profile: parsed, forwardedEnv } = resolveCrabboxProvisionProfile(
        profile,
        options?.machineClass,
      );
      const warmupTimeoutMs = parsed.desktop
        ? CRABBOX_DESKTOP_WARMUP_TIMEOUT_MS
        : CRABBOX_WARMUP_TIMEOUT_MS;
      const deadline = Date.now() + resolveCrabboxProvisionBaseTimeoutMs(parsed);
      const setupDeadline =
        deadline +
        countCrabboxProvisionSetupPhases(parsed) * CRABBOX_SETUP_TIMEOUT_MS +
        CRABBOX_NODE_ENROLLMENT_TIMEOUT_MS;
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
      if (parsed.desktop && parsed.provider === "hetzner") {
        await assertHetznerDesktopHasManagedCoordinator({ binary, runCommand });
      }
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

      await warmImages.allocate({
        ...context,
        id: leaseId,
        profile: parsed,
        slug,
        timeoutMs: () => remainingProvisionTimeout(deadline, warmupTimeoutMs),
      });
      let inspected: InspectCommandResult;
      try {
        inspected = await inspectWithContext({
          context,
          expectedLeaseId: leaseId,
          id: leaseId,
          runCommand,
          timeoutMs: remainingProvisionTimeout(
            deadline,
            resolveCrabboxLifecycleTimeoutMs(parsed.provider),
          ),
          waitForReady: parsed.provider === "machine0",
        });
      } catch (error) {
        // Transport failure after warmup is indeterminate; preserve the lease for durable replay.
        if (error instanceof WorkerProviderError) {
          return await failProvisionAfterCleanup({ ...context, id: leaseId, runCommand }, error);
        }
        throw error;
      }
      if (inspected.status === "unknown") {
        throw new Error("Crabbox warmup lease was not found during inspection");
      }
      const inspectedParams = {
        ...context,
        deadline,
        inspect: inspected.inspect,
        profile: parsed,
        runCommand,
      };
      if (isUnusableProvisionState(inspected.inspect.state)) {
        return await failProvisionAfterCleanup(
          { ...inspectedParams, id: leaseId },
          new WorkerProviderError("Crabbox warmup lease entered a terminal state"),
        );
      }
      inspectedParams.inspect = await waitForProvisionReady({ ...inspectedParams, sleep });
      inspectedParams.deadline = setupDeadline;
      if (parsed.setup) {
        inspectedParams.inspect = await runProvisionSetupAndWaitReady({
          ...inspectedParams,
          phase: "profile setup",
          setup: parsed.setup,
          forwardedEnv,
          sleep,
        });
      }
      if (parsed.desktop) {
        inspectedParams.inspect = await runProvisionSetupAndWaitReady({
          ...inspectedParams,
          phase: "desktop setup",
          setup: createCrabboxWorkerDesktopSetup(leaseId, wallpaperBase64),
          sleep,
        });
      }
      const beginNodeEnrollment = options?.beginNodeEnrollment;
      if (!beginNodeEnrollment) {
        return await failProvisionAfterCleanup(
          { ...inspectedParams, id: leaseId },
          new Error("Crabbox worker node enrollment is unavailable"),
        );
      }
      let enrollment: CrabboxWorkerNodeEnrollment;
      try {
        enrollment = await beginNodeEnrollment();
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw error;
        }
        return await failProvisionAfterCleanup({ ...inspectedParams, id: leaseId }, error);
      }
      const nodeEnrollmentSetup = createCrabboxNodeEnrollmentSetup({
        enrollment,
        executionMode,
        leaseId,
      });
      inspectedParams.inspect = await runProvisionSetupAndWaitReady({
        ...inspectedParams,
        phase: "node enrollment setup",
        setup: nodeEnrollmentSetup.command,
        timeoutMs: CRABBOX_NODE_ENROLLMENT_TIMEOUT_MS,
        ...(nodeEnrollmentSetup.forwardedEnv
          ? { forwardedEnv: nodeEnrollmentSetup.forwardedEnv }
          : {}),
        sleep,
      });
      let deviceId: string;
      try {
        deviceId = await enrollment.waitForDeviceId();
      } catch (error) {
        // Gateway shutdown cancels its wait, not the fixed operation-owned provider lease.
        if (enrollment.signal?.aborted) {
          throw error;
        }
        const leaseContext = { ...inspectedParams, id: leaseId };
        // Read node evidence before cleanup destroys its only copy on the leased machine.
        const evidence = await collectCrabboxNodeEnrollmentEvidence({
          ...leaseContext,
          args: leaseRunArgs(leaseContext),
          ...(enrollment.signal ? { signal: enrollment.signal } : {}),
        });
        enrollment.signal?.throwIfAborted();
        const message = error instanceof Error ? error.message : "Worker node enrollment failed";
        return await failProvisionAfterCleanup(
          leaseContext,
          new Error(`${message}; ${evidence}`, { cause: error }),
        );
      }
      if (parsed.warmImage) {
        openWarmLeases().register(leaseId, { machineClass: parsed.class });
      }
      heartbeats.start({
        binary,
        heartbeatIntervalMs: parsed.heartbeatIntervalMs,
        heartbeatTimeoutMs: parsed.heartbeatTimeoutMs,
        id: leaseId,
        idleTimeout: parsed.idleTimeout,
        provider: parsed.provider,
      });
      return {
        leaseId,
        node: { deviceId },
        sharedHost: false,
        ...(parsed.desktop ? { desktop: createCrabboxWorkerDesktopEndpoint() } : {}),
      };
    },
    async inspect(lease): Promise<WorkerLeaseStatus> {
      const { context } = resolveLeaseContext(lease);
      const inspected = await inspectWithContext({
        context,
        expectedLeaseId: context.id,
        id: context.id,
        runCommand,
      });
      if (inspected.status === "unknown") {
        heartbeats.stop(context.id);
        return { status: "unknown" };
      }
      // `ready` is an SSH probe; every recognized nonterminal lease remains active.
      if (isTerminalState(inspected.inspect.state)) {
        heartbeats.stop(context.id);
        return { status: "destroyed" };
      }
      heartbeats.start(context);
      return { status: "active" };
    },
    async destroy(lease): Promise<void> {
      const { context, profile } = resolveLeaseContext(lease);
      // Fence the provider keepalive before teardown so an in-flight touch cannot reschedule.
      heartbeats.stop(context.id);
      // Lifecycle profiles omit placement overrides. Successful enrollment records
      // the class that owns both the default warm policy and reusable image after restart.
      const machineClass = openWarmLeases().lookup(context.id)?.machineClass;
      const captureProfile = resolveCrabboxWarmImageProfile(profile, machineClass ?? profile.class);
      if (captureProfile.warmImage) {
        await warmImages.capture({
          ...context,
          profile: captureProfile,
          eligible: machineClass !== undefined,
        });
      }
      await stopLeaseWithLifecycleTimeout({ ...context, runCommand });
      if (machineClass !== undefined) {
        warmLeases?.delete(context.id);
      }
    },
  };
}
