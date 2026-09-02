import { setTimeout as delay } from "node:timers/promises";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import {
  WorkerProviderError,
  type WorkerLease,
  type WorkerLeaseStatus,
  type WorkerProfile,
  type WorkerProvider,
} from "openclaw/plugin-sdk/plugin-entry";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { crabboxCommandError } from "./crabbox-worker-command-error.js";
import {
  type CrabboxCommandRunner,
  runCrabboxCommand,
  stopCrabboxLease,
} from "./crabbox-worker-command.js";
import {
  createCrabboxWorkerDesktopEndpoint,
  createCrabboxWorkerDesktopSetup,
} from "./crabbox-worker-desktop-setup.js";
import { createCrabboxHeartbeatManager } from "./crabbox-worker-heartbeat.js";
import { createCrabboxMachineOptionsResolver } from "./crabbox-worker-machine-options.js";
import { collectCrabboxNodeEnrollmentEvidence } from "./crabbox-worker-node-enrollment-diagnostics.js";
import {
  createCrabboxNodeEnrollmentSetup,
  createCrabboxNodeRuntimeSetup,
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
import { prepareCrabboxProjectFiles } from "./crabbox-worker-project.js";
import {
  failProvisionAfterCleanup,
  inspectWithContext,
  isNonRunnableState,
  leaseRunArgs,
  remainingProvisionTimeout,
  runProvisionSetup,
  runProvisionSetupAndWaitReady,
  waitForProvisionReady,
  type InspectCommandResult,
  type LeaseCommandContext,
} from "./crabbox-worker-provision-commands.js";
import {
  countCrabboxProvisionSetupPhases,
  CRABBOX_COMMAND_SETTLEMENT_TIMEOUT_MS,
  CRABBOX_DESKTOP_WARMUP_TIMEOUT_MS,
  CRABBOX_LIFECYCLE_TIMEOUT_MS,
  CRABBOX_NODE_ENROLLMENT_TIMEOUT_MS,
  CRABBOX_SETUP_TIMEOUT_MS,
  CRABBOX_STOP_TIMEOUT_MS,
  CRABBOX_WARMUP_TIMEOUT_MS,
  resolveCrabboxLifecycleTimeoutMs,
  resolveCrabboxProvisionBaseTimeoutMs,
  resolveCrabboxProvisionCallTimeoutMs,
} from "./crabbox-worker-timeouts.js";
import { loadCrabboxWorkerWallpaperBase64 } from "./crabbox-worker-wallpaper.js";
import {
  createCrabboxWarmImageManager,
  resolveCrabboxWarmImageCaptureTimeoutMs,
} from "./crabbox-worker-warm-image.js";

export { resolveOpenClawRoot } from "./crabbox-worker-profile.js";

const MAX_ERROR_DETAIL_CHARS = 512;
// Local pack creation, two seed commands, upload, and runtime installation precede capture.
const CRABBOX_PROJECT_PREPARATION_TIMEOUT_MS =
  4 * CRABBOX_SETUP_TIMEOUT_MS + CRABBOX_NODE_ENROLLMENT_TIMEOUT_MS;
const LEASE_ID_PATTERN = /^(?:cbx_|tbx_)[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

type CrabboxProfile = ReturnType<typeof parseCrabboxProfile>;

type LeaseHeartbeatContext = LeaseCommandContext &
  Pick<CrabboxProfile, "heartbeatIntervalMs" | "heartbeatTimeoutMs" | "idleTimeout">;

type CrabboxWorkerProviderDependencies = {
  isExecutable?: (candidate: string) => boolean;
  openclawRoot?: string;
  pathEnv?: string;
  platform?: NodeJS.Platform;
  runCommand?: CrabboxCommandRunner;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  wallpaperPath: string;
  warn?: (message: string) => void;
};

async function loadCrabboxConfigShow(params: {
  binary: string;
  runCommand: CrabboxCommandRunner;
  signal?: AbortSignal;
}): Promise<unknown> {
  const result = await runCrabboxCommand({
    action: "config show",
    args: ["config", "show", "--json"],
    binary: params.binary,
    runCommand: params.runCommand,
    signal: params.signal,
    timeoutMs: CRABBOX_LIFECYCLE_TIMEOUT_MS,
  });
  if (result.termination !== "exit" || result.code !== 0) {
    throw crabboxCommandError("config show", result);
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error("Crabbox config show returned invalid JSON");
  }
}

async function assertAwsWorkerHasNoInstanceProfile(params: {
  binary: string;
  runCommand: CrabboxCommandRunner;
  signal?: AbortSignal;
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
  signal?: AbortSignal;
}): Promise<void> {
  const config = await loadCrabboxConfigShow(params);
  const view = isRecord(config) ? config : undefined;
  if (nonEmptyString(view?.coordinator) && view?.brokerMode === "managed") {
    return;
  }
  throw new Error("Crabbox Hetzner desktop profiles require a managed coordinator");
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
  stopLease: (context: LeaseCommandContext) => Promise<void>,
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
  // An unrecognized fixed ID can still own a live resource; let stop establish cleanup.
  try {
    await stopLease(context);
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
): WorkerProvider & { dispose: () => Promise<void> } {
  const wallpaperBase64 = loadCrabboxWorkerWallpaperBase64(dependencies.wallpaperPath);
  const runCommand = dependencies.runCommand ?? runCommandWithTimeout;
  const warn = dependencies.warn ?? (() => {});
  const sleep =
    dependencies.sleep ?? ((milliseconds, signal) => delay(milliseconds, undefined, { signal }));
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
  const maintenanceAbort = new AbortController();
  let maintenanceInFlight: Promise<void> | undefined;
  const stopLease = async (context: LeaseCommandContext): Promise<void> => {
    heartbeats.stop(context.id);
    // Cleanup has its own deadline. Only confirmed stop releases allocation/image ownership.
    await stopCrabboxLease({
      ...context,
      runCommand,
    });
    await warmImages.release(context);
  };
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

  const resolveAllocation: WorkerProvider["resolveAllocation"] = async (_profile, operationId) => ({
    leaseId: operationLeaseId(operationId),
    sharedHost: false,
  });

  return {
    id: CRABBOX_WORKER_PROVIDER_ID,
    async dispose() {
      heartbeats.dispose();
      maintenanceAbort.abort();
      await maintenanceInFlight?.catch(() => {});
    },
    maintain(context) {
      context.assertCurrent();
      maintenanceAbort.signal.throwIfAborted();
      return (maintenanceInFlight ??= Promise.resolve()
        .then(async () => {
          const signal = AbortSignal.any([context.signal, maintenanceAbort.signal]);
          const assertCurrent = () => {
            signal.throwIfAborted();
            context.assertCurrent();
          };
          assertCurrent();
          const binaries = new Set(
            context.profiles.map((profile) => resolveBinary(parseCrabboxProfile(profile).binary)),
          );
          if (binaries.size !== 1) {
            warn(
              "Crabbox warm-image maintenance requires one configured CLI executable; retained images were not changed. Check cloud worker profile binary settings.",
            );
            return;
          }
          // The standard CLI shares its process-configured catalog across backend profiles.
          // Checkpoint records, rather than the current profile, own native deletion routing.
          await warmImages.maintain({ binary: [...binaries][0]!, signal, assertCurrent });
        })
        .finally(() => {
          maintenanceInFlight = undefined;
        }));
    },
    listMachineOptions,
    supportedExecutionModes: ["worker-turn", "remote-exec"],
    provisionBeforeInstallation: true,
    requiresNodeEnrollment: true,
    supportsProjectPreparation(profile, machineClass) {
      const parsed = parseCrabboxProfile(profile);
      return resolveCrabboxWarmImageProfile(parsed, machineClass ?? parsed.class).warmImage;
    },
    resolveAllocation,
    resolveProvisionTimeoutMs(profile) {
      const parsed = parseCrabboxProfile(profile);
      return (
        resolveCrabboxProvisionCallTimeoutMs(parsed) +
        (parsed.warmImage === false
          ? 0
          : CRABBOX_PROJECT_PREPARATION_TIMEOUT_MS +
            resolveCrabboxWarmImageCaptureTimeoutMs(parsed.provider))
      );
    },
    resolveDestroyTimeoutMs(profile) {
      const parsed = parseCrabboxProfile(profile);
      // The lifecycle profile omits placement sizing, which may have enabled capture.
      // Reserve its full budget unless the profile explicitly disabled warm images.
      return (
        CRABBOX_STOP_TIMEOUT_MS +
        CRABBOX_COMMAND_SETTLEMENT_TIMEOUT_MS +
        (parsed.warmImage === false ? 0 : resolveCrabboxWarmImageCaptureTimeoutMs(parsed.provider))
      );
    },
    async provision(
      profile: WorkerProfile,
      operationId: string,
      options: Parameters<WorkerProvider["provision"]>[2],
    ): Promise<WorkerLease> {
      const signal = options?.signal;
      signal?.throwIfAborted();
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
      const project = parsed.warmImage ? options?.project : undefined;
      const preparationSignal =
        signal && project ? AbortSignal.any([signal, project.signal]) : (signal ?? project?.signal);
      const setupDeadline =
        deadline +
        countCrabboxProvisionSetupPhases(parsed) * CRABBOX_SETUP_TIMEOUT_MS +
        CRABBOX_NODE_ENROLLMENT_TIMEOUT_MS +
        (project
          ? CRABBOX_PROJECT_PREPARATION_TIMEOUT_MS +
            resolveCrabboxWarmImageCaptureTimeoutMs(parsed.provider)
          : 0);
      const allocation = await resolveAllocation(profile, operationId);
      signal?.throwIfAborted();
      const binary = resolveBinary(parsed.binary);
      const context = { binary, provider: parsed.provider };
      const leaseId = allocation.leaseId;
      if (parsed.desktop && parsed.provider === "hetzner") {
        await assertHetznerDesktopHasManagedCoordinator({ binary, runCommand, signal });
      }
      if (parsed.provider === "aws") {
        try {
          await assertAwsWorkerHasNoInstanceProfile({ binary, runCommand, signal });
        } catch (error) {
          signal?.throwIfAborted();
          if (!(error instanceof WorkerProviderError)) {
            throw error;
          }
          await rejectAwsProfileAfterLeaseReconciliation(
            { binary, id: leaseId, provider: parsed.provider },
            error,
            runCommand,
            stopLease,
          );
        }
      }

      const allocationChoice = await warmImages.allocate({
        ...context,
        id: leaseId,
        profile: parsed,
        ...(project ? { projectKey: project.key } : {}),
        ...(project ? { assertCurrent: project.assertCurrent } : {}),
        signal: preparationSignal,
        slug: operationSlug(operationId),
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
          signal: preparationSignal,
        });
        signal?.throwIfAborted();
      } catch (error) {
        signal?.throwIfAborted();
        // Transport failure after warmup is indeterminate; preserve the lease for durable replay.
        if (error instanceof WorkerProviderError) {
          return await failProvisionAfterCleanup({ ...context, id: leaseId, stopLease }, error);
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
        stopLease,
        signal: preparationSignal,
      };
      if (isNonRunnableState(inspected.inspect.state)) {
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
      if (project && warmImages.lookupLease(leaseId)?.phase !== "enrolled") {
        let preparationFailed = false;
        let captured: boolean;
        try {
          await prepareCrabboxProjectFiles({
            ...context,
            id: leaseId,
            project,
            runArgs: leaseRunArgs({ ...context, id: leaseId }),
            runCommand,
            signal: preparationSignal,
            timeoutMs: () => remainingProvisionTimeout(setupDeadline, CRABBOX_SETUP_TIMEOUT_MS),
          });
          project.assertCurrent();
          warmImages.markPrepared(leaseId, project.baseCommit);
          captured = await warmImages.capture(
            {
              ...context,
              id: leaseId,
              profile: parsed,
              signal: preparationSignal,
              assertCurrent: project.assertCurrent,
              ...(allocationChoice.kind === "checkpoint"
                ? { forkedCheckpointId: allocationChoice.checkpointId }
                : {}),
            },
            async () => {
              if (!options?.prepareNodeRuntime) {
                throw new Error("Crabbox project snapshots require node runtime preparation");
              }
              const runtime = await options.prepareNodeRuntime();
              signal?.throwIfAborted();
              project.assertCurrent();
              const setup = createCrabboxNodeRuntimeSetup({
                nodeBootstrap: runtime.nodeBootstrap,
                workerBundle: runtime.workerBundle,
                leaseId,
              });
              try {
                await runProvisionSetup({
                  ...inspectedParams,
                  phase: "node runtime preparation",
                  setup: setup.command,
                  forwardedEnv: setup.forwardedEnv,
                  timeoutMs: CRABBOX_NODE_ENROLLMENT_TIMEOUT_MS,
                  signal:
                    runtime.signal && preparationSignal
                      ? AbortSignal.any([preparationSignal, runtime.signal])
                      : (preparationSignal ?? runtime.signal),
                });
              } catch (error) {
                // The command owner settles setup failure and cleanup; do not stop it twice.
                preparationFailed = true;
                throw error;
              }
            },
          );
        } catch (error) {
          // The runtime grant has a separate abort signal; revalidate the project owner.
          signal?.throwIfAborted();
          project.assertCurrent();
          if (preparationFailed) {
            throw error;
          }
          return await failProvisionAfterCleanup({ ...context, id: leaseId, stopLease }, error);
        }
        // Only native capture can have restarted the source since preparation returned.
        if (captured) {
          inspectedParams.inspect = await waitForProvisionReady({
            ...inspectedParams,
            refresh: true,
            sleep,
          });
        }
      }
      signal?.throwIfAborted();
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
        signal?.throwIfAborted();
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof Error && error.name === "AbortError") {
          throw error;
        }
        return await failProvisionAfterCleanup({ ...inspectedParams, id: leaseId }, error);
      }
      const nodeEnrollmentSetup = createCrabboxNodeEnrollmentSetup({
        enrollment,
        desktop: parsed.desktop,
        leaseId,
      });
      const enrollmentSignal =
        preparationSignal && enrollment.signal
          ? AbortSignal.any([preparationSignal, enrollment.signal])
          : (preparationSignal ?? enrollment.signal);
      // These owned scripts do not restart SSH; authenticated enrollment proves node readiness.
      await runProvisionSetup({
        ...inspectedParams,
        phase: "node enrollment setup",
        signal: enrollmentSignal,
        setup: nodeEnrollmentSetup.command,
        timeoutMs: CRABBOX_NODE_ENROLLMENT_TIMEOUT_MS,
        ...(nodeEnrollmentSetup.forwardedEnv
          ? { forwardedEnv: nodeEnrollmentSetup.forwardedEnv }
          : {}),
      });
      let deviceId: string;
      try {
        deviceId = await enrollment.waitForDeviceId();
        signal?.throwIfAborted();
      } catch (error) {
        signal?.throwIfAborted();
        // Gateway shutdown cancels its wait, not the fixed operation-owned provider lease.
        if (enrollment.signal?.aborted) {
          throw error;
        }
        const leaseContext = { ...inspectedParams, id: leaseId };
        // Read node evidence before cleanup destroys its only copy on the leased machine.
        const evidence = await collectCrabboxNodeEnrollmentEvidence({
          ...leaseContext,
          args: leaseRunArgs(leaseContext),
          ...(enrollmentSignal ? { signal: enrollmentSignal } : {}),
        });
        signal?.throwIfAborted();
        enrollment.signal?.throwIfAborted();
        const message = error instanceof Error ? error.message : "Worker node enrollment failed";
        return await failProvisionAfterCleanup(
          leaseContext,
          new Error(`${message}; ${evidence}`, { cause: error }),
        );
      }
      if (parsed.warmImage) {
        warmImages.markEnrolled(leaseId);
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
        ...allocation,
        node: { deviceId },
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
      if (inspected.status === "unknown" || isNonRunnableState(inspected.inspect.state)) {
        heartbeats.stop(context.id);
        return { status: "unknown" };
      }
      // `ready` is an SSH probe; every recognized nonterminal lease remains active.
      heartbeats.start(context);
      return { status: "active" };
    },
    async destroy(lease): Promise<void> {
      const { context, profile } = resolveLeaseContext(lease);
      // Fence the provider keepalive before teardown so an in-flight touch cannot reschedule.
      heartbeats.stop(context.id);
      // Lifecycle profiles omit placement overrides. Successful enrollment records
      // the class that owns both the default warm policy and reusable image after restart.
      let captureError: unknown;
      try {
        const allocation = warmImages.lookupLease(context.id);
        const captureProfile = resolveCrabboxWarmImageProfile(
          profile,
          allocation?.machineClass ?? profile.class,
        );
        if (captureProfile.warmImage) {
          await warmImages.capture({ ...context, profile: captureProfile });
        }
      } catch (error) {
        captureError = error;
      }
      await stopLease(context);
      if (captureError) {
        throw captureError instanceof Error
          ? captureError
          : new Error(coerceErrorMessage(captureError));
      }
    },
  };
}
