// Managed service identity, shutdown, and recovery shared by update and Doctor.
import { Writable } from "node:stream";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { isGatewayServiceEnv, resolveGatewayProfileSuffix } from "../../daemon/constants.js";
import { resolveLaunchAgentLabel } from "../../daemon/launchd-label.js";
import { resolveTaskName } from "../../daemon/schtasks-layout.js";
import {
  isScheduledTaskDefinitelyNotRunning,
  readWindowsStartupFallbackRuntimeForUpdate,
} from "../../daemon/schtasks-runtime.js";
import { ScheduledTaskAutoStartRecoveryError } from "../../daemon/schtasks-update-recovery.js";
import {
  resumeScheduledTaskAutoStartAfterUpdate,
  suspendScheduledTaskAutoStartForUpdate,
} from "../../daemon/schtasks.js";
import {
  resolveManagedGatewayServiceCommand,
  type GatewayServiceState,
} from "../../daemon/service-types.js";
import { readGatewayServiceState, resolveGatewayService } from "../../daemon/service.js";
import { resolveSystemdServiceName } from "../../daemon/systemd-service-files.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { readActiveGatewayLockIdentity } from "../../infra/gateway-lock.js";
import { probePortUsage } from "../../infra/ports-probe.js";
import { finishUpdateRun, recordUpdateRunPhase } from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import {
  registerSignalExitBarrier,
  registerSignalExitGate,
  waitForSignalExitBarriers,
} from "../signal-exit-barrier.js";
import { UpdatePreMutationError, type UpdateCommandOptions } from "./shared.js";
import { gatewayAncestryBlockMessage } from "./update-command-handoff.js";
import {
  assertGatewayServiceAdmissionUnchanged,
  assertGatewayServiceManagementAllowedForUpdate,
  gatewayServiceCommandUsesRoot,
  GatewayServiceUpdateOwnershipError,
  resolveGatewayServiceManagementBlockMessageForUpdate,
  resolveManagedServiceNodeRunner,
  resolveUpdatedGatewayRestartPort,
  type ManagedGatewayUpdateVerdict,
} from "./update-command-service-plan.js";

const GATEWAY_SERVICE_INSPECTION_UNAVAILABLE_MESSAGE =
  "Gateway service management skipped: inspection is unavailable. Run `openclaw gateway status --deep` and restart the gateway manually when service access is restored.";
const GATEWAY_SERVICE_INSPECTION_BLOCK_MESSAGE =
  "Gateway service inspection is unavailable. Refusing to mutate code because managed service ownership cannot be verified. Run `openclaw gateway status --deep` and retry when service access is restored.";
const JSON_MODE_SERVICE_STDOUT = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

export type PreManagedServiceStop = {
  stoppedAtMs?: number;
  stopped: boolean;
  inspected: boolean;
  runtimeInspected: boolean;
  running: boolean;
  offline?: boolean;
  serviceMutationAllowed?: boolean;
  serviceMutationSkipMessage?: string;
  serviceUpdateVerdict?: ManagedGatewayUpdateVerdict;
  blockMessage?: string;
  serviceEnv?: NodeJS.ProcessEnv;
  serviceDefinitionEnv?: NodeJS.ProcessEnv;
  serviceNodeRunner?: string;
  windowsTaskAutoStartRecovery?: WindowsTaskAutoStartRecovery;
};

export function resolvePreparedGatewayUpdatePolicy(
  stopState: PreManagedServiceStop | undefined,
  shouldRestart: boolean,
) {
  const verdict = stopState?.serviceUpdateVerdict;
  // Root ownership permits activation; rewriting also requires definition authority.
  return {
    allowGatewayServiceRepair: verdict?.kind === "owned" && verdict.refreshDefinition,
    allowGatewayActivation:
      shouldRestart && stopState?.stopped === true && verdict?.kind === "owned",
  };
}

async function inspectManagedGatewayServiceBeforeUpdate(params: {
  root: string;
  state: GatewayServiceState;
}): Promise<ManagedGatewayUpdateVerdict> {
  const { state, root } = params;
  const { command } = state;
  const unavailable = (): ManagedGatewayUpdateVerdict => ({
    kind: "unavailable",
    message: GATEWAY_SERVICE_INSPECTION_UNAVAILABLE_MESSAGE,
  });
  if (!command) {
    return !state.installed &&
      state.loadState.status === "not-loaded" &&
      !state.running &&
      state.runtime?.missingUnit &&
      (await readActiveGatewayLockIdentity({ env: state.env, requireInspection: true }).then(
        (identity) => !identity,
        () => false,
      )) &&
      (await probePortUsage(await resolveUpdatedGatewayRestartPort({ serviceEnv: state.env }))) ===
        "free"
      ? { kind: "absent" }
      : unavailable();
  }
  // Lifecycle authority follows the effective launcher, not the writable base
  // that a drop-in may replace with a different installation.
  const ownsRoot = await gatewayServiceCommandUsesRoot({ root, command });
  if (ownsRoot === false) {
    return { kind: "foreign" };
  }
  if (
    state.loadState.status === "unknown" ||
    (state.runtime?.status !== "running" && state.runtime?.status !== "stopped")
  ) {
    return unavailable();
  }
  const serialized = stableStringify(command);
  if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) {
    return unavailable();
  }
  const fingerprint = sha256Hex(serialized);
  return ownsRoot
    ? {
        kind: "owned",
        root,
        fingerprint,
        refreshDefinition: (state.definitionMutationCapability?.kind ?? "writable") === "writable",
      }
    : { kind: "unresolved", root, fingerprint };
}

function matchesStoppedService(
  before: Pick<PreManagedServiceStop, "serviceEnv" | "serviceUpdateVerdict">,
  state: GatewayServiceState,
  inspection: ManagedGatewayUpdateVerdict,
): boolean {
  const verdict = before.serviceUpdateVerdict;
  const refreshDefinition = verdict?.kind === "owned" && verdict.refreshDefinition;
  const resolveName =
    process.platform === "darwin"
      ? resolveLaunchAgentLabel
      : process.platform === "win32"
        ? resolveTaskName
        : resolveSystemdServiceName;
  // Explicit default metadata selects the same manager; protected command hashes
  // still pin the effective launcher and its environment through normalization.
  return Boolean(
    before.serviceEnv &&
    state.command &&
    verdict &&
    "fingerprint" in verdict &&
    resolveGatewayProfileSuffix(before.serviceEnv.OPENCLAW_PROFILE) ===
      resolveGatewayProfileSuffix(state.env.OPENCLAW_PROFILE) &&
    resolveName(before.serviceEnv) === resolveName(state.env) &&
    (refreshDefinition ||
      ("fingerprint" in inspection && inspection.fingerprint === verdict.fingerprint)),
  );
}

export async function revalidateManagedGatewayServiceAfterUpdate(params: {
  state: GatewayServiceState;
  root: string;
  preManagedServiceStop?: Pick<PreManagedServiceStop, "serviceEnv" | "serviceUpdateVerdict">;
  allowInstallRootChange?: boolean;
}): Promise<ManagedGatewayUpdateVerdict> {
  const before = params.preManagedServiceStop;
  const verdict = before?.serviceUpdateVerdict;
  assertGatewayServiceManagementAllowedForUpdate(params.state.env);
  const inspection = await inspectManagedGatewayServiceBeforeUpdate(params);
  if (
    params.allowInstallRootChange &&
    before &&
    verdict?.kind === "owned" &&
    verdict.refreshDefinition &&
    (inspection.kind === "foreign" || inspection.kind === "unresolved") &&
    (params.state.definitionMutationCapability?.kind ?? "writable") === "writable"
  ) {
    const retained = await inspectManagedGatewayServiceBeforeUpdate({
      state: params.state,
      root: verdict.root,
    });
    // A verified core install can replace its root before rewriting the launcher.
    // Pin the original command even when pnpm has removed its old package directory.
    if (
      matchesStoppedService(
        { ...before, serviceUpdateVerdict: { ...verdict, refreshDefinition: false } },
        params.state,
        retained,
      )
    ) {
      return { ...verdict, requiresInstallRootRefresh: true };
    }
  }
  if (
    before &&
    verdict &&
    (verdict.kind === "owned" || verdict.kind === "unresolved") &&
    (inspection.kind !== verdict.kind || !matchesStoppedService(before, params.state, inspection))
  ) {
    throw new GatewayServiceUpdateOwnershipError(
      "Gateway service ownership or manager identity changed; inspect it before restarting manually.",
      undefined,
    );
  }
  return inspection.kind === "owned" && verdict?.kind === "owned" && !verdict.refreshDefinition
    ? { ...inspection, refreshDefinition: false }
    : inspection;
}

type WindowsTaskAutoStartRecovery = {
  beginMutation: () => void;
  restore: (restartSafe?: boolean) => Promise<void>;
  complete: (restartSafe?: boolean) => Promise<void>;
  interrupted: () => boolean;
};

export type UpdateCommandRecoveryState = {
  windowsTaskAutoStartRecovery?: WindowsTaskAutoStartRecovery;
  ledgerHandoffOwned?: boolean;
  triageTarget: import("./update-command-triage.js").UpdateTriageTarget;
};

export class UpdateCommandAbort extends Error {
  constructor() {
    super("openclaw-update-abort");
    this.name = "UpdateCommandAbort";
  }
}

function serviceControlStdoutForMode(jsonMode: boolean): NodeJS.WritableStream {
  return jsonMode ? JSON_MODE_SERVICE_STDOUT : process.stdout;
}

async function maybeSuspendWindowsTaskAutoStartForUpdate(params: {
  serviceEnv: NodeJS.ProcessEnv | undefined;
  assertCurrentService?: () => Promise<void>;
  updateRun?: UpdateCommandOptions["run"];
}): Promise<WindowsTaskAutoStartRecovery | undefined> {
  const { serviceEnv, assertCurrentService, updateRun } = params;
  if (process.platform !== "win32" || !serviceEnv) {
    return undefined;
  }
  let restorePromise: Promise<void> | undefined;
  let settlement: Promise<void> | undefined;
  let restorationAttempted = false;
  let restorationFailed = false;
  let restoreAllowed = true;
  let unregisterSignalExitBarrier = () => {};
  let finishUpdate: (() => void) | undefined;
  let interrupted = false;
  const updateFinished = new Promise<void>((resolve) => {
    finishUpdate = resolve;
  });
  const unregisterSignalExitGate = registerSignalExitGate(updateFinished);
  // Cancellation can restore the task before mutation. Once lifecycle work
  // starts, only an explicit safe result may re-enable persistent autostart.
  const onSignal = (exitCode: number) => {
    interrupted = true;
    void waitForSignalExitBarriers()
      .catch((err: unknown) => {
        defaultRuntime.error(`Failed to complete update shutdown cleanup: ${String(err)}`);
      })
      .finally(() => {
        process.exit(exitCode);
      });
  };
  const onSigint = () => onSignal(130);
  const onSigterm = () => onSignal(143);
  const onSigbreak = () => onSignal(130);
  const removeSignalHandlers = () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("SIGBREAK", onSigbreak);
    unregisterSignalExitBarrier();
  };
  const complete = (restartSafe = true) => {
    if (settlement) {
      return settlement.catch(() => undefined);
    }
    const recordInterruption = interrupted && (restoreAllowed || restorationFailed);
    restoreAllowed = false;
    settlement = (async () => {
      await restorePromise?.catch(() => undefined);
      if (!restartSafe && restorationAttempted && (await suspensionPromise.catch(() => false))) {
        // Failed verification revokes autostart, even if /ENABLE committed before
        // reporting failure. Compensation must never re-enable the rejected runtime.
        await suspendScheduledTaskAutoStartForUpdate(serviceEnv, {
          beforeMutation: assertCurrentService,
          restoreOnFailure: false,
        });
      }
    })().finally(() => {
      try {
        if (finishUpdate && recordInterruption && updateRun) {
          const failed = restorationFailed || !restartSafe;
          finishUpdateRun(
            updateRun.runId,
            {
              status: failed ? "failed" : "skipped",
              reason: restorationFailed
                ? "windows-task-autostart-restore-failed"
                : failed
                  ? "update-failed"
                  : "cancelled",
            },
            { env: updateRun.env },
          );
        }
      } finally {
        removeSignalHandlers();
        finishUpdate?.();
        finishUpdate = undefined;
        unregisterSignalExitGate();
      }
    });
    return settlement;
  };
  const restore = (restartSafe?: boolean) => {
    // Finalization has already reported this lifecycle's outcome. A retained
    // cleanup handle cannot reopen it or replay its settled restoration error.
    if (!finishUpdate || settlement) {
      return Promise.resolve();
    }
    if (restartSafe === true) {
      restoreAllowed = true;
    }
    restorePromise ??= suspensionPromise
      .then(async (suspended) => {
        if (suspended && restoreAllowed && !settlement) {
          await assertCurrentService?.();
          await resumeScheduledTaskAutoStartAfterUpdate(serviceEnv, {
            beforeMutation: async () => {
              await assertCurrentService?.();
              if (settlement || !restoreAllowed) {
                throw new Error("Windows task restoration authority has closed.");
              }
              restorationAttempted = true;
            },
          });
        }
      })
      .catch((error: unknown) => {
        restorationFailed = true;
        throw error;
      })
      .finally(removeSignalHandlers);
    return restorePromise;
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("SIGBREAK", onSigbreak);
  unregisterSignalExitBarrier = registerSignalExitBarrier(restore);
  // Arm recovery before starting the persistent state change. A signal arriving
  // while schtasks is still returning waits for that result before restoring.
  const suspensionPromise = suspendScheduledTaskAutoStartForUpdate(serviceEnv);
  const recovery: WindowsTaskAutoStartRecovery = {
    beginMutation: () => {
      // Async preflight may outlive a signal or settled recovery. Admit mutation
      // only while this owner can still keep native autostart suspended.
      if (interrupted || settlement || !finishUpdate) {
        throw new UpdateCommandAbort();
      }
      restoreAllowed = false;
    },
    restore,
    complete,
    interrupted: () => interrupted,
  };
  let suspended: boolean;
  try {
    suspended = await suspensionPromise;
  } catch (err) {
    await recovery.restore().catch(() => undefined);
    await recovery.complete(!(err instanceof ScheduledTaskAutoStartRecoveryError));
    throw err;
  }
  await abortWindowsTaskUpdateIfInterrupted(recovery);
  if (!suspended) {
    try {
      await recovery.restore();
    } finally {
      await recovery.complete();
    }
    return undefined;
  }
  return recovery;
}

async function abortWindowsTaskUpdateIfInterrupted(
  recovery: WindowsTaskAutoStartRecovery,
): Promise<void> {
  if (!recovery.interrupted()) {
    return;
  }
  try {
    await recovery.restore();
  } finally {
    await recovery.complete();
  }
  throw new UpdateCommandAbort();
}

export async function maybeResumeWindowsTaskAutoStartAfterPackageUpdate(
  stopState: PreManagedServiceStop | undefined,
  restartSafe?: boolean,
): Promise<void> {
  if (!stopState?.windowsTaskAutoStartRecovery) {
    return;
  }
  // Retain the suspension through verification so a failed activation can revoke
  // autostart; the owner makes restoration and final settlement idempotent.
  await stopState.windowsTaskAutoStartRecovery.restore(restartSafe);
}

export async function maybeStopManagedServiceBeforeMutableUpdate(params: {
  updateRun?: UpdateCommandOptions["run"];
  updateInstallKind: "git" | "package";
  root: string;
  shouldRestart: boolean;
  jsonMode: boolean;
  phase?: "inspect" | "prepare";
  handoffFromGateway?: (state: GatewayServiceState) => Promise<boolean>;
  expectedService?: Pick<PreManagedServiceStop, "serviceEnv" | "serviceUpdateVerdict">;
  timeoutMs?: number;
}): Promise<PreManagedServiceStop> {
  const uninspected = { stopped: false, inspected: false, runtimeInspected: false, running: false };
  const markInspectionUnavailable = (
    base: PreManagedServiceStop,
    message: string,
  ): PreManagedServiceStop => ({
    ...base,
    serviceMutationAllowed: false,
    serviceUpdateVerdict: { kind: "unavailable", message },
    blockMessage: GATEWAY_SERVICE_INSPECTION_BLOCK_MESSAGE,
  });
  const serviceMutationSkipMessage = resolveGatewayServiceManagementBlockMessageForUpdate(
    process.env,
  );
  if (serviceMutationSkipMessage) {
    return { ...uninspected, serviceMutationAllowed: false, serviceMutationSkipMessage };
  }
  let service: ReturnType<typeof resolveGatewayService>;
  let serviceState: GatewayServiceState;
  try {
    service = resolveGatewayService();
    serviceState = await readGatewayServiceState(service, {
      env: process.env,
      requireEffective: true,
      validateEnvBeforeStatusRead: assertGatewayServiceManagementAllowedForUpdate,
      timeoutMs: params.timeoutMs,
    });
  } catch (err) {
    if (err instanceof GatewayServiceUpdateOwnershipError) {
      return { ...uninspected, serviceMutationAllowed: false, blockMessage: err.message };
    }
    return markInspectionUnavailable(uninspected, GATEWAY_SERVICE_INSPECTION_UNAVAILABLE_MESSAGE);
  }
  const serviceUpdateVerdict = await revalidateManagedGatewayServiceAfterUpdate({
    root: params.root,
    state: serviceState,
    preManagedServiceStop: params.expectedService,
  });
  if (params.phase) {
    // Explicit admission phases pin the pre-update definition. Post-update
    // maintenance retains the canonical owner check above, which permits the
    // updater's authorized service refresh after activation.
    assertGatewayServiceAdmissionUnchanged(params.expectedService, serviceUpdateVerdict);
  }
  const inspected = {
    stopped: false,
    inspected: true,
    runtimeInspected: ["running", "stopped"].includes(serviceState.runtime?.status ?? ""),
    running: serviceState.running,
    // Enabled systemd units may be manually stopped; loaded LaunchAgents can
    // respawn. Windows needs the live numeric task state, not its last result.
    offline:
      serviceState.runtime?.status === "stopped" &&
      (process.platform === "darwin"
        ? serviceState.loadState.status === "not-loaded" ||
          (serviceState.loadState.status === "loaded" &&
            (await service
              .isEnabled?.({ env: serviceState.env, timeoutMs: params.timeoutMs })
              .catch(() => undefined)) === false)
        : process.platform === "win32"
          ? isScheduledTaskDefinitelyNotRunning(resolveTaskName(serviceState.env)) ||
            (await readWindowsStartupFallbackRuntimeForUpdate(serviceState.env).catch(() => null))
              ?.status === "stopped"
          : process.platform === "linux"),
    serviceEnv: serviceState.env,
    serviceDefinitionEnv:
      resolveManagedGatewayServiceCommand(serviceState.command)?.environment ?? {},
    serviceNodeRunner: resolveManagedServiceNodeRunner(serviceState.command),
    serviceUpdateVerdict,
  };
  if (serviceUpdateVerdict.kind === "unavailable") {
    return markInspectionUnavailable(inspected, serviceUpdateVerdict.message);
  }
  if (serviceUpdateVerdict.kind === "foreign") {
    return {
      ...inspected,
      serviceMutationAllowed: false,
      serviceMutationSkipMessage:
        "Gateway service management skipped: the service belongs to a different OpenClaw installation and was left untouched.",
    };
  }
  if (serviceUpdateVerdict.kind === "absent") {
    return {
      ...inspected,
      serviceMutationAllowed: false,
      serviceMutationSkipMessage:
        "Gateway restart skipped: no Gateway service or listener is running.",
    };
  }
  // Pure inventory inspection supplies no handoff callback. Execution supplies it
  // only after complete target admission, before online candidate validation.
  if (
    params.shouldRestart &&
    serviceState.running &&
    (await params.handoffFromGateway?.(serviceState))
  ) {
    throw new UpdateCommandAbort();
  }
  if (params.phase === "inspect") {
    const blockMessage = params.handoffFromGateway
      ? gatewayAncestryBlockMessage(serviceState.runtime?.pid)
      : undefined;
    return blockMessage ? { ...inspected, blockMessage } : inspected;
  }
  const suspendTask = () =>
    maybeSuspendWindowsTaskAutoStartForUpdate({
      serviceEnv: serviceState.env,
      updateRun: params.updateRun,
      // Doctor pins a definition for the whole repair. Ordinary updates may
      // hand off to a replacement package root before restoring task autostart.
      assertCurrentService: params.expectedService
        ? async () => {
            const state = await readGatewayServiceState(service, {
              env: serviceState.env,
              requireEffective: true,
              validateEnvBeforeStatusRead: assertGatewayServiceManagementAllowedForUpdate,
              timeoutMs: params.timeoutMs,
            });
            await revalidateManagedGatewayServiceAfterUpdate({
              state,
              root: params.root,
              preManagedServiceStop: inspected,
            });
          }
        : undefined,
    });
  // A loaded LaunchAgent can be between KeepAlive respawns. Other supervisors
  // need the handoff marker to distinguish that transition from operator-stopped state.
  const supervisorMayRespawn =
    params.shouldRestart &&
    serviceState.loadState.status === "loaded" &&
    (process.platform === "darwin"
      ? (await service.isEnabled?.({ env: serviceState.env })) === true
      : process.env.OPENCLAW_UPDATE_RUN_HANDOFF === "1");
  if (!params.shouldRestart || (!serviceState.running && !supervisorMayRespawn)) {
    if (!params.shouldRestart && !params.jsonMode && serviceState.running) {
      const warning = `--no-restart is set while the managed gateway service is running; the ${params.updateInstallKind} update will not stop or restart that process.`;
      defaultRuntime.log(theme.warn(warning));
    }
    const windowsTaskAutoStartRecovery =
      !params.shouldRestart && isGatewayServiceEnv(process.env) ? undefined : await suspendTask();
    return {
      ...inspected,
      ...(windowsTaskAutoStartRecovery ? { windowsTaskAutoStartRecovery } : {}),
    };
  }
  const blockMessage = gatewayAncestryBlockMessage(serviceState.runtime?.pid);
  if (blockMessage) {
    return { ...inspected, running: true, blockMessage };
  }

  if (!params.jsonMode) {
    const message = `Stopping managed gateway service before ${params.updateInstallKind} update...`;
    defaultRuntime.log(theme.muted(message));
  }
  const windowsTaskAutoStartRecovery = await suspendTask();
  let stoppedAtMs: number | undefined;
  try {
    // Ownership inspection and native preparation await work. Recheck the exact
    // launcher before stopping so a replacement service cannot inherit authority.
    const currentState = await readGatewayServiceState(service, {
      env: serviceState.env,
      requireEffective: true,
      validateEnvBeforeStatusRead: assertGatewayServiceManagementAllowedForUpdate,
      timeoutMs: params.timeoutMs,
    });
    await revalidateManagedGatewayServiceAfterUpdate({
      state: currentState,
      root: params.root,
      preManagedServiceStop: {
        serviceEnv: serviceState.env,
        serviceUpdateVerdict:
          serviceUpdateVerdict.kind === "owned"
            ? { ...serviceUpdateVerdict, refreshDefinition: false }
            : serviceUpdateVerdict,
      },
    });
    const currentBlockMessage = gatewayAncestryBlockMessage(currentState.runtime?.pid);
    if (currentBlockMessage) {
      throw new UpdatePreMutationError("managed-service-preflight", currentBlockMessage);
    }
    stoppedAtMs = Date.now();
    if (params.updateRun) {
      recordUpdateRunPhase(params.updateRun.runId, "activating", undefined, {
        env: params.updateRun.env,
      });
    }
    await service.stop({
      env: currentState.env,
      stdout: serviceControlStdoutForMode(params.jsonMode),
    });
    if (windowsTaskAutoStartRecovery) {
      await abortWindowsTaskUpdateIfInterrupted(windowsTaskAutoStartRecovery);
    }
  } catch (err) {
    if (err instanceof UpdateCommandAbort) {
      throw err;
    }
    if (windowsTaskAutoStartRecovery) {
      let autostartRestored = false;
      try {
        await windowsTaskAutoStartRecovery.restore();
        autostartRestored = true;
      } catch (resumeErr) {
        throw new ScheduledTaskAutoStartRecoveryError(
          [err, resumeErr],
          `Failed to stop the managed gateway (${String(err)}) and restore Windows Scheduled Task autostart (${String(resumeErr)})`,
          serviceState.env,
        );
      } finally {
        await windowsTaskAutoStartRecovery.complete(autostartRestored);
      }
      if (windowsTaskAutoStartRecovery.interrupted()) {
        throw new UpdateCommandAbort();
      }
    }
    throw err;
  }
  return {
    ...inspected,
    stopped: true,
    stoppedAtMs,
    serviceDefinitionEnv:
      resolveManagedGatewayServiceCommand(serviceState.command)?.environment ?? {},
    ...(windowsTaskAutoStartRecovery ? { windowsTaskAutoStartRecovery } : {}),
  };
}

export function shouldBlockMutableUpdateFromGatewayServiceEnv(params: {
  preManagedServiceStop: PreManagedServiceStop | undefined;
}): boolean {
  const stopState = params.preManagedServiceStop;
  return (
    isGatewayServiceEnv(process.env) &&
    (!stopState?.inspected ||
      (!stopState.stopped &&
        (!stopState.runtimeInspected ||
          (stopState.running &&
            (!stopState.blockMessage || stopState.serviceUpdateVerdict?.kind === "unavailable")))))
  );
}
