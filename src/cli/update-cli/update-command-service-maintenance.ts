// Managed service identity, shutdown, and recovery shared by update and Doctor.
import { Writable } from "node:stream";
import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { createConfigIO } from "../../config/io.js";
import { resolveGatewayPort } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  GATEWAY_SERVICE_RUNTIME_PID_ENV,
  isGatewayServiceEnv,
  resolveGatewayProfileSuffix,
} from "../../daemon/constants.js";
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
  type GatewayServiceCommandConfig,
  type GatewayServiceState,
} from "../../daemon/service-types.js";
import { readGatewayServiceState, resolveGatewayService } from "../../daemon/service.js";
import { resolveSystemdServiceName } from "../../daemon/systemd-service-files.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { getSelfAndAncestorPidsSync } from "../../infra/restart-stale-pids.js";
import { parseTcpPortFromArgs } from "../../infra/tcp-port.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import {
  renderRestartDiagnostics,
  waitForGatewayHealthyRestart,
} from "../daemon-cli/restart-health.js";
import {
  registerSignalExitBarrier,
  registerSignalExitGate,
  waitForSignalExitBarriers,
} from "../signal-exit-barrier.js";
import { UpdatePreMutationError } from "./shared.js";
import { runUpdatedInstallGatewayCommand } from "./update-command-service-command.js";
import {
  assertGatewayServiceManagementAllowedForUpdate,
  gatewayServiceCommandUsesRoot,
  GatewayServiceUpdateOwnershipError,
  resolveGatewayServiceManagementBlockMessageForUpdate,
} from "./update-command-service-plan.js";

const GATEWAY_SERVICE_INSPECTION_UNAVAILABLE_MESSAGE =
  "Gateway service management skipped: inspection is unavailable. Run `openclaw gateway status --deep` and restart the gateway manually when service access is restored.";
const GATEWAY_SERVICE_INSPECTION_BLOCK_MESSAGE =
  "Gateway service inspection is unavailable. Refusing to mutate code while automatic restart is enabled; run `openclaw gateway status --deep` and retry when service access is restored. To use `--no-restart`, stop the Gateway manually before the update, then restart it manually afterward.";
const JSON_MODE_SERVICE_STDOUT = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

export type PreManagedServiceStop = {
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

export type ManagedGatewayUpdateVerdict =
  | { kind: "absent" | "foreign" }
  | {
      kind: "owned";
      root: string;
      fingerprint: string;
      refreshDefinition: boolean;
      requiresInstallRootRefresh?: boolean;
    }
  | { kind: "unresolved"; root: string; fingerprint: string }
  | { kind: "unavailable"; message: string };

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
      state.runtime?.missingUnit
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
  suspended: Promise<boolean>;
  beginMutation: () => void;
  restore: (restartSafe?: boolean) => Promise<void>;
  complete: (restartSafe?: boolean) => void;
  interrupted: () => boolean;
};

export type UpdateCommandRecoveryState = {
  windowsTaskAutoStartRecovery?: WindowsTaskAutoStartRecovery;
  triageTarget: import("./update-command-triage.js").UpdateTriageTarget;
};

export class UpdateCommandAbort extends Error {
  constructor() {
    super("openclaw-update-abort");
    this.name = "UpdateCommandAbort";
  }
}

function parsePositivePid(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
  }
  const trimmed = typeof value === "string" ? value.trim() : "";
  return /^\d+$/u.test(trimmed) ? (parseStrictPositiveInteger(trimmed) ?? null) : null;
}

function gatewayAncestryBlockMessage(pid: unknown): string | undefined {
  const gatewayPid = parsePositivePid(pid);
  if (gatewayPid === null) {
    return undefined;
  }
  const inherited =
    isGatewayServiceEnv(process.env) &&
    parsePositivePid(process.env[GATEWAY_SERVICE_RUNTIME_PID_ENV]) === gatewayPid;
  if (!inherited && !getSelfAndAncestorPidsSync().has(gatewayPid)) {
    return undefined;
  }
  return `This command is running inside the gateway process tree.
Gateway PID ${gatewayPid} is an ancestor of this process, so this command cannot safely stop or restart the gateway that owns it.
Run this command from a shell outside the gateway service, or stop the gateway service first and retry.`;
}

function serviceControlStdoutForMode(jsonMode: boolean): NodeJS.WritableStream {
  return jsonMode ? JSON_MODE_SERVICE_STDOUT : process.stdout;
}

function armWindowsTaskAutoStartRecovery(
  serviceEnv: NodeJS.ProcessEnv,
  assertCurrentService?: () => Promise<void>,
): WindowsTaskAutoStartRecovery {
  let restorePromise: Promise<void> | undefined;
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
    if (!restartSafe) {
      // Re-enabling a rejected installation would let a login trigger bypass
      // the updater's unsafe-stop decision after this process has exited.
      restoreAllowed = false;
      removeSignalHandlers();
    }
    finishUpdate?.();
    finishUpdate = undefined;
    unregisterSignalExitGate();
  };
  const restore = (restartSafe?: boolean) => {
    // Finalization has already reported this lifecycle's outcome. A retained
    // cleanup handle cannot reopen it or replay its settled restoration error.
    if (!finishUpdate) {
      return Promise.resolve();
    }
    if (restartSafe === true) {
      restoreAllowed = true;
    }
    restorePromise ??= suspensionPromise
      .then(async (suspended) => {
        if (suspended && restoreAllowed) {
          // Enabling a replaced task would activate an owner this operation never
          // stopped. Revalidate even on failure and signal recovery paths.
          await assertCurrentService?.();
          await resumeScheduledTaskAutoStartAfterUpdate(serviceEnv);
        }
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
  return {
    suspended: suspensionPromise,
    beginMutation: () => {
      restoreAllowed = false;
    },
    restore,
    complete,
    interrupted: () => interrupted,
  };
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
    recovery.complete();
  }
  throw new UpdateCommandAbort();
}

async function maybeSuspendWindowsTaskAutoStartForUpdate(params: {
  serviceEnv: NodeJS.ProcessEnv | undefined;
  assertCurrentService?: () => Promise<void>;
}): Promise<WindowsTaskAutoStartRecovery | undefined> {
  if (process.platform !== "win32" || !params.serviceEnv) {
    return undefined;
  }
  const recovery = armWindowsTaskAutoStartRecovery(params.serviceEnv, params.assertCurrentService);
  let suspended: boolean;
  try {
    suspended = await recovery.suspended;
  } catch (err) {
    await recovery.restore().catch(() => undefined);
    recovery.complete(!(err instanceof ScheduledTaskAutoStartRecoveryError));
    throw err;
  }
  await abortWindowsTaskUpdateIfInterrupted(recovery);
  if (!suspended) {
    try {
      await recovery.restore();
    } finally {
      recovery.complete();
    }
    return undefined;
  }
  return recovery;
}

export async function maybeResumeWindowsTaskAutoStartAfterPackageUpdate(
  stopState: PreManagedServiceStop | undefined,
  restartSafe?: boolean,
): Promise<void> {
  if (!stopState?.windowsTaskAutoStartRecovery) {
    return;
  }
  // The recovery exists only when this update disabled an enabled task. Clear it
  // after use so later failure paths cannot repeat the state change.
  await stopState.windowsTaskAutoStartRecovery.restore(restartSafe);
  stopState.windowsTaskAutoStartRecovery = undefined;
}

export async function maybeStopManagedServiceBeforeMutableUpdate(params: {
  updateInstallKind: "git" | "package";
  root: string;
  shouldRestart: boolean;
  jsonMode: boolean;
  phase?: "inspect" | "prepare";
  expectedService?: Pick<PreManagedServiceStop, "serviceEnv" | "serviceUpdateVerdict">;
  timeoutMs?: number;
}): Promise<PreManagedServiceStop> {
  const uninspected = { stopped: false, inspected: false, runtimeInspected: false, running: false };
  const markInspectionUnavailable = (
    base: PreManagedServiceStop,
    message: string,
  ): PreManagedServiceStop =>
    params.shouldRestart
      ? {
          ...base,
          serviceMutationAllowed: false,
          blockMessage: GATEWAY_SERVICE_INSPECTION_BLOCK_MESSAGE,
        }
      : { ...base, serviceMutationAllowed: false, serviceMutationSkipMessage: message };
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
  if (serviceUpdateVerdict.kind === "absent" || params.phase === "inspect") {
    return inspected;
  }
  const suspendTask = () =>
    maybeSuspendWindowsTaskAutoStartForUpdate({
      serviceEnv: serviceState.env,
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
        windowsTaskAutoStartRecovery.complete(autostartRestored);
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
    serviceDefinitionEnv:
      resolveManagedGatewayServiceCommand(serviceState.command)?.environment ?? {},
    ...(windowsTaskAutoStartRecovery ? { windowsTaskAutoStartRecovery } : {}),
  };
}

export async function maybeRestartServiceAfterFailedMutableUpdate(params: {
  preManagedServiceStop: PreManagedServiceStop | undefined;
  recovery?: UpdateRunResult["recovery"];
  jsonMode: boolean;
  nodeRunner?: string;
  timeoutMs?: number;
  invocationCwd?: string;
}): Promise<"healthy" | "failed" | undefined> {
  const before = params.preManagedServiceStop;
  if (!before?.stopped || !before.serviceEnv) {
    return undefined;
  }
  if (params.recovery?.serviceRestartSafe !== true || !params.recovery.version) {
    defaultRuntime.error(
      "Managed gateway remains stopped: update safety is unverified. Run `openclaw doctor` and inspect the update failure before restarting.",
    );
    return "failed";
  }
  try {
    const verdict = before.serviceUpdateVerdict;
    if (!verdict || !("root" in verdict)) {
      throw new Error(
        "Stopped service ownership is unknown; restart it manually after inspection.",
      );
    }
    const service = resolveGatewayService();
    let expectedService: Pick<PreManagedServiceStop, "serviceEnv" | "serviceUpdateVerdict"> =
      before;
    const readCurrentService = async () => {
      const state = await readGatewayServiceState(service, {
        env: before.serviceEnv,
        requireEffective: true,
        validateEnvBeforeStatusRead: assertGatewayServiceManagementAllowedForUpdate,
        timeoutMs: params.timeoutMs,
      });
      const inspection = await revalidateManagedGatewayServiceAfterUpdate({
        state,
        root: verdict.root,
        preManagedServiceStop: expectedService,
      });
      // Recovery preserves the current definition. Once observed, even a same-unit
      // replacement during config or health awaits must not inherit this activation.
      expectedService = {
        serviceEnv: state.env,
        serviceUpdateVerdict:
          inspection.kind === "owned" ? { ...inspection, refreshDefinition: false } : inspection,
      };
      return state;
    };
    const state = await readCurrentService();
    const port = await resolveUpdatedGatewayRestartPort({
      serviceEnv: state.env,
      serviceCommand: state.command,
    });
    // Context resolution awaits config reads. Revalidate before the one activation;
    // the installed CLI owns its config dialect and preserves the service definition.
    const current = await readCurrentService();
    await runUpdatedInstallGatewayCommand(
      {
        result: { root: verdict.root },
        opts: { json: params.jsonMode },
        invocationEnv: before.serviceEnv,
        serviceEnv: current.env,
        nodeRunner: params.nodeRunner,
        timeoutMs: params.timeoutMs,
        invocationCwd: params.invocationCwd,
      },
      "restart",
      true,
    );
    const health = await waitForGatewayHealthyRestart({
      service,
      port,
      env: current.env,
      expectedVersion: params.recovery.version,
      expectedBuildId: params.recovery.buildId,
      requireRunningService: true,
    });
    if (!health.healthy || health.runtime.status !== "running") {
      throw new Error(renderRestartDiagnostics(health).join("\n"));
    }
    await readCurrentService();
    if (!params.jsonMode) {
      defaultRuntime.log(
        theme.muted(
          "Recovered managed gateway service and verified readiness after failed update.",
        ),
      );
    }
    return "healthy";
  } catch (err) {
    defaultRuntime.error(
      `Failed to restart managed gateway service after failed update: ${String(err)}. Run \`openclaw gateway status --deep\` before restarting it manually.`,
    );
    return "failed";
  }
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

export async function resolveUpdatedGatewayRestartPort(params: {
  config?: OpenClawConfig;
  processEnv?: NodeJS.ProcessEnv;
  serviceEnv?: NodeJS.ProcessEnv;
  serviceCommand?: GatewayServiceCommandConfig | null;
}): Promise<number> {
  const env = params.serviceEnv ?? params.processEnv ?? process.env;
  let config = params.config;
  if (params.serviceCommand) {
    // Preserved launchers keep their explicit port and their own config context;
    // refresh callers omit the old command and use the intended new configuration.
    const port = parseTcpPortFromArgs(params.serviceCommand.programArguments);
    if (port !== null) {
      return port;
    }
    config = await createConfigIO({
      env,
      observe: false,
      pluginValidation: "skip",
      suppressFutureVersionWarning: true,
    }).readBestEffortConfig();
  }
  return resolveGatewayPort(config, env);
}
