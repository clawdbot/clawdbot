// Managed gateway service lifecycle before and after an update.
import fs from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { confirm, isCancel } from "@clack/prompts";
import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { err as resultError, ok, type Result } from "@openclaw/normalization-core/result";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { stylePromptMessage } from "../../../packages/terminal-core/src/prompt-style.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import {
  checkShellCompletionStatus,
  ensureCompletionCacheExists,
} from "../../commands/doctor-completion.js";
import { doctorCommand } from "../../commands/doctor.js";
import { UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV } from "../../commands/doctor/shared/update-phase.js";
import { resolveGatewayPort } from "../../config/config.js";
import { createConfigIO } from "../../config/io.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  GATEWAY_SERVICE_RUNTIME_PID_ENV,
  isGatewayServiceEnv,
  resolveGatewayProfileSuffix,
} from "../../daemon/constants.js";
import { resolveGatewayInstallEntrypoint } from "../../daemon/gateway-entrypoint.js";
import { resolveLaunchAgentLabel } from "../../daemon/launchd-label.js";
import { resolveGatewayRestartLogPath } from "../../daemon/restart-logs.js";
import { resolveTaskName } from "../../daemon/schtasks-layout.js";
import {
  resumeScheduledTaskAutoStartAfterUpdate,
  suspendScheduledTaskAutoStartForUpdate,
} from "../../daemon/schtasks.js";
import { summarizeGatewayServiceLayout } from "../../daemon/service-layout.js";
import {
  resolveManagedGatewayServiceCommand,
  type GatewayServiceCommandConfig,
  type GatewayServiceState,
} from "../../daemon/service-types.js";
import { readGatewayServiceState, resolveGatewayService } from "../../daemon/service.js";
import { resolveSystemdServiceName } from "../../daemon/systemd-service-files.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { assertGatewayServiceMutationAllowed } from "../../infra/gateway-supervision.js";
import { getSelfAndAncestorPidsSync } from "../../infra/restart-stale-pids.js";
import { nodeVersionSatisfiesEngine } from "../../infra/runtime-guard.js";
import { parseTcpPortFromArgs } from "../../infra/tcp-port.js";
import type { UpdateChannel } from "../../infra/update-channels.js";
import { fetchNpmPackageTargetStatus } from "../../infra/update-check-package-target.js";
import { canResolveRegistryVersionForPackageTarget } from "../../infra/update-global.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { replaceCliName, resolveCliName } from "../cli-name.js";
import { formatCliCommand } from "../command-format.js";
import { installCompletion } from "../completion-runtime.js";
import { runDaemonInstall, runDaemonRestart } from "../daemon-cli.js";
import {
  renderRestartDiagnostics,
  terminateStaleGatewayPids,
  waitForGatewayHealthyRestart,
} from "../daemon-cli/restart-health.js";
import {
  registerSignalExitBarrier,
  registerSignalExitGate,
  waitForSignalExitBarriers,
} from "../signal-exit-barrier.js";
import { runRestartScript } from "./restart-helper.js";
import { resolveNodeRunner, type UpdateCommandOptions } from "./shared.js";
import { createUpdateConfigSnapshot } from "./update-command-config.js";
import { resolveUpdatedInstallCommandEnv } from "./update-command-service-env.js";
import {
  formatPostUpdateGatewayRecoveryInstructions,
  hasLoadedLaunchdKeepAliveSupervisor,
  isPackageManagerUpdateMode,
  recoverLaunchAgentAndRecheckGatewayHealth,
  shouldUseLegacyProcessRestartAfterUpdate,
} from "./update-command-service-recovery.js";

export { isPackageManagerUpdateMode } from "./update-command-service-recovery.js";

const CLI_NAME = resolveCliName();
const SERVICE_REFRESH_TIMEOUT_MS = 60_000;
const DEFINITION_DENIAL = /\bSERVICE_DEFINITION_(?:SEALED|UNKNOWN):[^\n]*/;
const POST_REFRESH_ALREADY_HEALTHY_ATTEMPTS = 10;
const POST_REFRESH_ALREADY_HEALTHY_DELAY_MS = 500;
const JSON_MODE_SERVICE_STDOUT = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

export function shouldPrepareUpdatedInstallRestart(params: {
  updateMode: UpdateRunResult["mode"];
  serviceInstalled: boolean;
  serviceLoaded: boolean;
  serviceStoppedForUpdate?: boolean;
  serviceMatchesUpdateRoot?: boolean;
}): boolean {
  const useInstalledState =
    isPackageManagerUpdateMode(params.updateMode) ||
    (params.updateMode === "git" && params.serviceStoppedForUpdate);
  return useInstalledState
    ? params.serviceInstalled
    : params.serviceLoaded &&
        (params.updateMode !== "git" || params.serviceMatchesUpdateRoot === true);
}

export type PreManagedServiceStop = {
  stopped: boolean;
  inspected: boolean;
  runtimeInspected: boolean;
  running: boolean;
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

type ManagedGatewayUpdateVerdict =
  | { kind: "absent" | "foreign" }
  | { kind: "owned"; root: string; fingerprint: string; refreshDefinition: boolean }
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
    message:
      "Gateway service management skipped: its owner or runtime could not be inspected. " +
      "Code update can continue; run `openclaw gateway status --deep` and restart the gateway manually when service access is restored.",
  });
  if (!command) {
    return !state.installed && !state.running && state.runtime?.missingUnit
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
}): Promise<ManagedGatewayUpdateVerdict> {
  const before = params.preManagedServiceStop;
  const verdict = before?.serviceUpdateVerdict;
  assertGatewayServiceManagementAllowedForUpdate(params.state.env);
  const inspection = await inspectManagedGatewayServiceBeforeUpdate(params);
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
  restore: () => Promise<void>;
  complete: () => void;
  interrupted: () => boolean;
};

export type UpdateCommandRecoveryState = {
  windowsTaskAutoStartRecovery?: WindowsTaskAutoStartRecovery;
};

export class GatewayServiceUpdateOwnershipError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "GatewayServiceUpdateOwnershipError";
  }
}

export function resolveGatewayServiceManagementBlockMessageForUpdate(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  try {
    assertGatewayServiceManagementAllowedForUpdate(env);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export function assertGatewayServiceManagementAllowedForUpdate(
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    assertGatewayServiceMutationAllowed("manage the gateway service during update", env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new GatewayServiceUpdateOwnershipError(message, err);
  }
}

export function isGatewayServiceManagementAllowedForUpdate(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveGatewayServiceManagementBlockMessageForUpdate(env) === undefined;
}

export class UpdateCommandAbort extends Error {
  constructor() {
    super("openclaw-update-abort");
    this.name = "UpdateCommandAbort";
  }
}

export function createAggregateErrorWithCause(
  errors: unknown[],
  message: string,
  cause: unknown,
): AggregateError {
  return new AggregateError(errors, message, { cause });
}

export type ManagedServiceRootRedirect = {
  root: string;
  previousRoot: string;
  nodeRunner?: string;
};

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
  return `openclaw update detected it is running inside the gateway process tree.
Gateway PID ${gatewayPid} is an ancestor of this process, so this updater cannot safely stop or restart the gateway that owns it.
Run \`${replaceCliName(formatCliCommand("openclaw update"), CLI_NAME)}\` from a shell outside the gateway service, or stop the gateway service first and then update.`;
}

function serviceControlStdoutForMode(jsonMode: boolean): NodeJS.WritableStream {
  return jsonMode ? JSON_MODE_SERVICE_STDOUT : process.stdout;
}

function armWindowsTaskAutoStartRecovery(
  serviceEnv: NodeJS.ProcessEnv,
): WindowsTaskAutoStartRecovery {
  let restorePromise: Promise<void> | undefined;
  let unregisterSignalExitBarrier = () => {};
  let finishUpdate: (() => void) | undefined;
  let interrupted = false;
  const updateFinished = new Promise<void>((resolve) => {
    finishUpdate = resolve;
  });
  const unregisterSignalExitGate = registerSignalExitGate(updateFinished);
  // Task Scheduler persists the disabled bit beyond this process, so recover it
  // before normal signal exits as well as from the update's ordinary paths.
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
  const complete = () => {
    finishUpdate?.();
    finishUpdate = undefined;
    unregisterSignalExitGate();
  };
  const restore = () => {
    restorePromise ??= suspensionPromise
      .then(async (suspended) => {
        if (suspended) {
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
  return { suspended: suspensionPromise, restore, complete, interrupted: () => interrupted };
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

async function maybeSuspendWindowsTaskAutoStartForPackageUpdate(params: {
  updateInstallKind: "git" | "package";
  serviceEnv: NodeJS.ProcessEnv | undefined;
}): Promise<WindowsTaskAutoStartRecovery | undefined> {
  if (
    params.updateInstallKind !== "package" ||
    process.platform !== "win32" ||
    !params.serviceEnv
  ) {
    return undefined;
  }
  const recovery = armWindowsTaskAutoStartRecovery(params.serviceEnv);
  let suspended: boolean;
  try {
    suspended = await recovery.suspended;
  } catch (err) {
    await recovery.restore().catch(() => undefined);
    recovery.complete();
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
): Promise<void> {
  if (!stopState?.windowsTaskAutoStartRecovery) {
    return;
  }
  // The recovery exists only when this update disabled an enabled task. Clear it
  // after use so later failure paths cannot repeat the state change.
  await stopState.windowsTaskAutoStartRecovery.restore();
  stopState.windowsTaskAutoStartRecovery = undefined;
}

export async function restoreWindowsTaskAutoStartOrExit(
  stopState: PreManagedServiceStop | undefined,
): Promise<boolean> {
  try {
    await maybeResumeWindowsTaskAutoStartAfterPackageUpdate(stopState);
    return true;
  } catch (err) {
    defaultRuntime.error(
      `Failed to restore Windows Scheduled Task autostart after package update: ${String(err)}`,
    );
    defaultRuntime.exit(1);
    return false;
  }
}

export async function maybeStopManagedServiceBeforeMutableUpdate(params: {
  updateInstallKind: "git" | "package";
  root: string;
  shouldRestart: boolean;
  jsonMode: boolean;
  phase?: "inspect" | "prepare";
  timeoutMs?: number;
}): Promise<PreManagedServiceStop> {
  const uninspected = { stopped: false, inspected: false, runtimeInspected: false, running: false };
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
    return {
      ...uninspected,
      serviceMutationAllowed: false,
      serviceMutationSkipMessage:
        "Gateway service management skipped: inspection is unavailable. Code update can continue; " +
        "run `openclaw gateway status --deep` and restart the gateway manually when service access is restored.",
    };
  }
  const serviceUpdateVerdict = await inspectManagedGatewayServiceBeforeUpdate({
    root: params.root,
    state: serviceState,
  });
  const inspected = {
    stopped: false,
    inspected: true,
    runtimeInspected: ["running", "stopped"].includes(serviceState.runtime?.status ?? ""),
    running: serviceState.running,
    serviceEnv: serviceState.env,
    serviceUpdateVerdict,
  };
  if (serviceUpdateVerdict.kind === "unavailable") {
    return {
      ...inspected,
      serviceMutationAllowed: false,
      serviceMutationSkipMessage: serviceUpdateVerdict.message,
    };
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
    maybeSuspendWindowsTaskAutoStartForPackageUpdate({
      updateInstallKind: params.updateInstallKind,
      serviceEnv: serviceState.env,
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
    await service.stop({
      env: serviceState.env,
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
      try {
        await windowsTaskAutoStartRecovery.restore();
      } catch (resumeErr) {
        throw createAggregateErrorWithCause(
          [err, resumeErr],
          `Failed to stop the managed gateway (${String(err)}) and restore Windows Scheduled Task autostart (${String(resumeErr)})`,
          err,
        );
      } finally {
        windowsTaskAutoStartRecovery.complete();
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
  root?: string;
  jsonMode: boolean;
}): Promise<void> {
  const before = params.preManagedServiceStop;
  if (!before?.stopped || !before.serviceEnv) {
    return;
  }
  try {
    const verdict = before.serviceUpdateVerdict;
    if (!verdict || !("root" in verdict)) {
      throw new Error(
        "Stopped service ownership is unknown; restart it manually after inspection.",
      );
    }
    const service = resolveGatewayService();
    const state = await readGatewayServiceState(service, {
      env: before.serviceEnv,
      requireEffective: true,
      validateEnvBeforeStatusRead: assertGatewayServiceManagementAllowedForUpdate,
    });
    // Recovery follows the verified installation or the update's returned replacement root.
    const revalidated = await revalidateManagedGatewayServiceAfterUpdate({
      state,
      root: params.root ?? verdict.root,
      preManagedServiceStop: before,
    });
    await service.restart({
      env: state.env,
      preserveDefinition: revalidated.kind !== "owned" || !revalidated.refreshDefinition,
      stdout: serviceControlStdoutForMode(params.jsonMode),
    });
    if (!params.jsonMode) {
      defaultRuntime.log(theme.muted("Restarted managed gateway service after failed update."));
    }
  } catch (err) {
    defaultRuntime.error(
      `Failed to restart managed gateway service after failed update: ${String(err)}`,
    );
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
        (!stopState.runtimeInspected || (stopState.running && !stopState.blockMessage))))
  );
}

function formatCommandFailure(stdout: string, stderr: string): string {
  // Keep the stable denial even when JSON stdout accompanies unrelated stderr warnings.
  const detail = `${stderr}\n${stdout}`.match(DEFINITION_DENIAL)?.[0] ?? (stderr || stdout).trim();
  return detail ? detail.split("\n").slice(-3).join("\n") : "command returned a non-zero exit code";
}

export function tryResolveInvocationCwd(): string | undefined {
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
}

type PackageRuntimePreflight = {
  nodeRunner?: string;
  replacedNodeRunner?: string;
  targetVersion?: string;
};

export async function resolvePackageRuntimePreflight(params: {
  tag: string;
  timeoutMs?: number;
  nodeRunner?: string;
  fallbackNodeRunner?: string;
  spec?: string;
  command?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<Result<PackageRuntimePreflight, string>> {
  const nodeRunner = normalizeOptionalString(params.nodeRunner);
  const unchanged = (): PackageRuntimePreflight => (nodeRunner ? { nodeRunner } : {});
  const target = params.tag.trim();
  if (
    !target ||
    !canResolveRegistryVersionForPackageTarget(params.tag) ||
    (params.spec && !canResolveRegistryVersionForPackageTarget(params.spec))
  ) {
    return ok(unchanged());
  }
  const status = await fetchNpmPackageTargetStatus({
    target,
    spec: params.spec,
    timeoutMs: params.timeoutMs,
    command: params.command,
    cwd: params.cwd,
    env: params.env,
  });
  if (status.error) {
    return ok(unchanged());
  }
  const runtime = await resolvePackageRuntimeForPreflight({
    nodeRunner,
    timeoutMs: params.timeoutMs,
  });
  const satisfies = nodeVersionSatisfiesEngine(runtime.version, status.nodeEngine);
  const targetVersion = status.version ?? target;
  const unchangedRuntime = { ...unchanged(), targetVersion };
  if (satisfies === true) {
    return ok(unchangedRuntime);
  }
  const fallbackNodeRunner = normalizeOptionalString(params.fallbackNodeRunner);
  if (nodeRunner && fallbackNodeRunner && fallbackNodeRunner !== nodeRunner) {
    const fallbackRuntime = await resolvePackageRuntimeForPreflight({
      nodeRunner: fallbackNodeRunner,
      timeoutMs: params.timeoutMs,
    });
    const fallbackSatisfies = nodeVersionSatisfiesEngine(
      fallbackRuntime.version,
      status.nodeEngine,
    );
    if (fallbackSatisfies === true) {
      return ok({
        nodeRunner: fallbackNodeRunner,
        replacedNodeRunner: nodeRunner,
        targetVersion,
      });
    }
  }
  if (satisfies !== false) {
    return ok(unchangedRuntime);
  }
  const runtimeLabel = runtime.nodeRunner
    ? `Node ${runtime.version ?? "unknown"} at ${runtime.nodeRunner}`
    : `Node ${runtime.version ?? "unknown"}`;
  return resultError(
    [
      `${runtimeLabel} is too old for openclaw@${targetVersion}.`,
      `The requested package requires ${status.nodeEngine}.`,
      runtime.nodeRunner
        ? "Upgrade the Node runtime that owns the managed Gateway service, then rerun `openclaw update`."
        : "Upgrade to Node 22.22.3+, Node 24.15.0+, or Node 25.9.0+, then rerun `openclaw update`.",
      "Bare `npm i -g openclaw` can silently install an older compatible release.",
      "After upgrading Node, use `npm i -g openclaw@latest`.",
    ].join("\n"),
  );
}

async function resolvePackageRuntimeForPreflight(params: {
  nodeRunner?: string;
  timeoutMs?: number;
}): Promise<{ version: string | null; nodeRunner?: string }> {
  const nodeRunner = normalizeOptionalString(params.nodeRunner);
  if (!nodeRunner) {
    return { version: process.versions.node ?? null };
  }
  const res = await runCommandWithTimeout([nodeRunner, "--version"], {
    timeoutMs: Math.min(params.timeoutMs ?? 10_000, 10_000),
  }).catch(() => null);
  return {
    version: res?.code === 0 ? res.stdout.trim().replace(/^v/u, "") || null : null,
    nodeRunner,
  };
}

export { disableUpdatedPackageCompileCacheEnv } from "./update-command-service-env.js";

export function stripGatewayServiceMarkerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const resolvedEnv = { ...env };
  delete resolvedEnv.OPENCLAW_SERVICE_MARKER;
  delete resolvedEnv.OPENCLAW_SERVICE_KIND;
  delete resolvedEnv[GATEWAY_SERVICE_RUNTIME_PID_ENV];
  return resolvedEnv;
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

export function resolvePostUpdateServiceStateReadEnv(params: {
  updateMode: UpdateRunResult["mode"];
  processEnv?: NodeJS.ProcessEnv;
  preManagedServiceEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const fallbackEnv = params.processEnv ?? process.env;
  const usesServiceEnv =
    params.updateMode === "git" || isPackageManagerUpdateMode(params.updateMode);
  return usesServiceEnv ? (params.preManagedServiceEnv ?? fallbackEnv) : fallbackEnv;
}

// Use the candidate's version guards for both refresh and activation. The parsed
// preservation option makes older targets reject before repair, without a retry.
async function runUpdatedInstallGatewayCommand(
  params: Parameters<typeof maybeRestartService>[0],
  action: "install" | "restart",
  preserveDefinition = false,
): Promise<boolean> {
  const installing = action === "install";
  const entrypoint = await resolveGatewayInstallEntrypoint(params.result.root);
  if (!entrypoint) {
    if (installing && !isPackageManagerUpdateMode(params.result.mode)) {
      await runDaemonInstall({ force: true, json: params.opts.json || undefined });
      return true;
    }
    throw new Error(
      `updated install entrypoint not found under ${params.result.root ?? "unknown"}`,
    );
  }
  const args = ["gateway", action];
  if (installing) {
    args.push("--force");
  } else if (preserveDefinition) {
    args.push("--preserve-definition");
  }
  if (params.opts.json) {
    args.push("--json");
  }
  const res = await runCommandWithTimeout(
    [params.nodeRunner ?? resolveNodeRunner(), entrypoint, ...args],
    {
      cwd: params.result.root,
      env: resolveUpdatedInstallCommandEnv({
        processEnv: installing ? (params.serviceInstallEnv ?? process.env) : process.env,
        serviceEnv: installing ? undefined : params.serviceEnv,
        invocationCwd: params.invocationCwd,
      }),
      // Restart owns migration-aware readiness; only refresh has the fixed watchdog.
      timeoutMs: installing ? SERVICE_REFRESH_TIMEOUT_MS : params.timeoutMs,
    },
  );
  if (res.code === 0) {
    return true;
  }
  const operation = installing ? "refresh" : "restart";
  throw new Error(
    `updated install ${operation} failed (${entrypoint}): ${formatCommandFailure(res.stdout, res.stderr)}`,
  );
}

export async function tryInstallShellCompletion(opts: {
  jsonMode: boolean;
  skipPrompt: boolean;
}): Promise<void> {
  if (opts.jsonMode || !process.stdin.isTTY) {
    return;
  }

  try {
    const status = await checkShellCompletionStatus(CLI_NAME);
    const generationOptions = { generationMode: "core-only" } as const;

    if (status.usesSlowPattern) {
      defaultRuntime.log(theme.muted("Upgrading shell completion to cached version..."));
      if (!(await ensureCompletionCacheExists(CLI_NAME, generationOptions))) {
        throw new Error("completion cache generation failed");
      }
      await installCompletion(status.shell, true, CLI_NAME);
      return;
    }

    if (status.profileInstalled && !status.cacheExists) {
      defaultRuntime.log(theme.muted("Regenerating shell completion cache..."));
      if (!(await ensureCompletionCacheExists(CLI_NAME, generationOptions))) {
        throw new Error("completion cache generation failed");
      }
      return;
    }

    if (!status.profileInstalled) {
      defaultRuntime.log("");
      defaultRuntime.log(theme.heading("Shell completion"));

      const shouldInstall = await confirm({
        message: stylePromptMessage(`Enable ${status.shell} shell completion for ${CLI_NAME}?`),
        initialValue: true,
      });

      if (isCancel(shouldInstall) || !shouldInstall) {
        if (!opts.skipPrompt) {
          defaultRuntime.log(
            theme.muted(
              `Skipped. Run \`${replaceCliName(formatCliCommand("openclaw completion --install"), CLI_NAME)}\` later to enable.`,
            ),
          );
        }
        return;
      }

      if (!(await ensureCompletionCacheExists(CLI_NAME, generationOptions))) {
        throw new Error("completion cache generation failed");
      }
      await installCompletion(status.shell, opts.skipPrompt, CLI_NAME);
    }
  } catch (err) {
    const message = formatErrorMessage(err);
    defaultRuntime.log(
      theme.warn(
        `Shell completion refresh failed: ${message}. Update will continue; retry with: ${replaceCliName(formatCliCommand("openclaw completion --write-state --install"), CLI_NAME)}`,
      ),
    );
  }
}

async function tryRealpathOrResolve(value: string): Promise<string> {
  return await fs.realpath(path.resolve(value)).catch(() => path.resolve(value));
}

function resolveManagedServiceNodeRunner(
  command: GatewayServiceCommandConfig | null,
): string | undefined {
  const args = command?.programArguments ?? [];
  // Native heap flags and dev loaders separate the executable from the entrypoint.
  const runner = args.indexOf("gateway") > 1 ? args[0] : undefined;
  const executable = normalizeOptionalString(runner ? path.basename(runner) : undefined);
  return ["node", "node.exe"].includes(executable?.toLowerCase() ?? "") ? runner : undefined;
}

/**
 * Resolve the node binary baked into the managed gateway service unit,
 * independent of any package root redirect. This detects when the user's
 * current PATH-resolved node differs from the service's baked node even
 * when the package root is the same.
 */
export async function resolveManagedServiceNodeRunnerOverride(): Promise<string | undefined> {
  if (!isGatewayServiceManagementAllowedForUpdate(process.env)) {
    return undefined;
  }
  const command = await resolveGatewayService()
    .readCommand(process.env, { requireEffective: true })
    .catch(() => null);
  const serviceNode = resolveManagedServiceNodeRunner(command);
  if (!serviceNode) {
    return undefined;
  }
  const currentNode = resolveNodeRunner();
  const [serviceNodeReal, currentNodeReal] = await Promise.all([
    tryRealpathOrResolve(serviceNode),
    tryRealpathOrResolve(currentNode),
  ]);
  return serviceNodeReal === currentNodeReal ? undefined : serviceNode;
}

export async function resolveManagedServicePackageUpdateRoot(params: {
  root: string;
}): Promise<ManagedServiceRootRedirect | null> {
  if (!isGatewayServiceManagementAllowedForUpdate(process.env)) {
    return null;
  }
  const command = await resolveGatewayService()
    .readCommand(process.env, { requireEffective: true })
    .catch(() => null);
  const layout = await summarizeGatewayServiceLayout(command);
  const serviceRoot = layout?.packageRoot;
  if (!serviceRoot || layout.entrypointSourceCheckout === true) {
    return null;
  }
  const [currentRootReal, serviceRootReal] = await Promise.all([
    tryRealpathOrResolve(params.root),
    tryRealpathOrResolve(serviceRoot),
  ]);
  if (currentRootReal === serviceRootReal) {
    return null;
  }
  const nodeRunner = resolveManagedServiceNodeRunner(command);
  return {
    root: serviceRoot,
    previousRoot: params.root,
    ...(nodeRunner ? { nodeRunner } : {}),
  };
}

export async function gatewayServiceCommandUsesRoot(params: {
  root: string | undefined;
  env?: NodeJS.ProcessEnv;
  command?: GatewayServiceCommandConfig | null;
}): Promise<boolean | null> {
  const expectedRoot = normalizeOptionalString(params.root);
  if (!expectedRoot) {
    return null;
  }
  const command =
    params.command === undefined
      ? isGatewayServiceManagementAllowedForUpdate(params.env ?? process.env)
        ? await resolveGatewayService()
            .readCommand(params.env ?? process.env, { requireEffective: true })
            .catch(() => null)
        : null
      : params.command;
  const layout = await summarizeGatewayServiceLayout(command);
  const serviceRoot = layout?.packageRoot;
  const serviceEntrypoint = layout?.entrypoint;
  if (
    !serviceRoot ||
    !serviceEntrypoint ||
    (!path.isAbsolute(serviceEntrypoint) && !path.win32.isAbsolute(serviceEntrypoint))
  ) {
    return null;
  }
  const [expectedRootReal, serviceRootReal] = await Promise.all([
    tryRealpathOrResolve(expectedRoot),
    tryRealpathOrResolve(serviceRoot),
  ]);
  if (expectedRootReal === serviceRootReal) {
    return true;
  }
  // Paired read-only release mounts have different paths but the same directory
  // identity. Copies of another release must remain foreign.
  const [expected, actual] = await Promise.all(
    [expectedRootReal, serviceRootReal].map((root) => fs.stat(root).catch(() => null)),
  );
  if (expected && actual && expected.dev === actual.dev && expected.ino === actual.ino) {
    return true;
  }
  const managed = command?.managedDefinition;
  if (
    !managed ||
    (await gatewayServiceCommandUsesRoot({ root: expectedRoot, command: managed })) !== true
  ) {
    return false;
  }
  const namespace = path.dirname(expectedRootReal);
  const managedLayout = await summarizeGatewayServiceLayout(managed);
  const stableEntry = path.join(
    namespace,
    "current",
    "dist",
    path.basename(managedLayout?.entrypoint ?? ""),
  );
  if (serviceEntrypoint !== stableEntry) {
    return false;
  }
  // Deployment-owned current points into this installation's releases, either
  // by symlink or by a paired bind mount. Unrelated namespaces remain foreign.
  const releases = path.join(namespace, "releases");
  if (serviceRootReal.startsWith(`${releases}${path.sep}`)) {
    return true;
  }
  try {
    for await (const entry of await fs.opendir(releases)) {
      const candidate = await fs.lstat(path.join(releases, entry.name));
      if (actual && candidate.dev === actual.dev && candidate.ino === actual.ino) {
        return true;
      }
    }
  } catch {
    // Without directory identity proof, the override cannot authorize lifecycle actions.
  }
  return false;
}

export async function maybeRestartService(params: {
  shouldRestart: boolean;
  result: UpdateRunResult;
  channel: UpdateChannel;
  opts: UpdateCommandOptions;
  refreshServiceEnv: boolean;
  serviceEnv?: NodeJS.ProcessEnv;
  serviceInstallEnv?: NodeJS.ProcessEnv | null;
  serviceUpdateVerdict?: ManagedGatewayUpdateVerdict;
  gatewayPort: number;
  restartScriptPath?: string | null;
  invocationCwd?: string;
  nodeRunner?: string;
  skipLegacyServiceRestart?: boolean;
  requireRunningServiceAfterRestart?: boolean;
  serviceMutationSkipMessage?: string;
  timeoutMs: number;
}): Promise<boolean> {
  if (
    params.shouldRestart &&
    (!isGatewayServiceManagementAllowedForUpdate(process.env) ||
      !isGatewayServiceManagementAllowedForUpdate(params.serviceEnv ?? process.env))
  ) {
    const message =
      resolveGatewayServiceManagementBlockMessageForUpdate(process.env) ??
      resolveGatewayServiceManagementBlockMessageForUpdate(params.serviceEnv ?? process.env);
    if (message) {
      defaultRuntime.error(message);
    }
    return false;
  }
  let activation = params;
  const verdict = activation.serviceUpdateVerdict;
  let preserveDefinition =
    verdict?.kind === "unresolved" || (verdict?.kind === "owned" && !verdict.refreshDefinition);
  const isPackageUpdate = isPackageManagerUpdateMode(activation.result.mode);
  const requiresVerifiedRestart = () =>
    preserveDefinition || isPackageUpdate || activation.requireRunningServiceAfterRestart;
  const canRestartUpdatedInstall = () =>
    preserveDefinition ||
    (isPackageUpdate &&
      (activation.refreshServiceEnv ||
        activation.serviceInstallEnv === null ||
        activation.requireRunningServiceAfterRestart));
  if (preserveDefinition) {
    defaultRuntime.error(
      "Gateway service definition left unchanged; ask its deployment owner to repair stale metadata if needed.",
    );
  }
  if (activation.serviceMutationSkipMessage) {
    defaultRuntime.error(activation.serviceMutationSkipMessage);
    return true;
  }
  const verifyRestartedGateway = async (
    expectedGatewayVersion: string | undefined,
    expectedGatewayBuildId: string | undefined,
    opts: { requireRunningService?: boolean } = {},
  ) => {
    const service = resolveGatewayService();
    const waitForHealthy = async () =>
      await waitForGatewayHealthyRestart({
        service,
        port: activation.gatewayPort,
        expectedVersion: expectedGatewayVersion,
        ...(expectedGatewayBuildId ? { expectedBuildId: expectedGatewayBuildId } : {}),
        env: activation.serviceEnv,
        requireRunningService: opts.requireRunningService,
        supervisorKeepsAlive: await hasLoadedLaunchdKeepAliveSupervisor({
          service,
          env: activation.serviceEnv,
        }),
      });
    let health = await waitForHealthy();
    if (!health.healthy && health.staleGatewayPids.length > 0) {
      if (!activation.opts.json) {
        defaultRuntime.log(
          theme.warn(
            `Found stale gateway process(es) after restart: ${health.staleGatewayPids.join(", ")}. Cleaning up...`,
          ),
        );
      }
      await terminateStaleGatewayPids(health.staleGatewayPids);
      if (canRestartUpdatedInstall()) {
        await runUpdatedInstallGatewayCommand(activation, "restart", preserveDefinition);
      } else if (shouldUseLegacyProcessRestartAfterUpdate({ updateMode: activation.result.mode })) {
        await runDaemonRestart();
      }
      health = await waitForHealthy();
    }

    const recoveryVerification = await recoverLaunchAgentAndRecheckGatewayHealth({
      preserveDefinition,
      health,
      service,
      port: activation.gatewayPort,
      expectedVersion: expectedGatewayVersion,
      ...(expectedGatewayBuildId ? { expectedBuildId: expectedGatewayBuildId } : {}),
      env: activation.serviceEnv,
    });
    health = recoveryVerification.health;
    const launchAgentRecovery = recoveryVerification.launchAgentRecovery;
    if (launchAgentRecovery?.attempted) {
      defaultRuntime.error(
        launchAgentRecovery.recovered ? launchAgentRecovery.message : launchAgentRecovery.detail,
      );
    }

    const serviceRuntimeHealthy =
      !opts.requireRunningService || health.runtime.status === "running";
    if (health.healthy && serviceRuntimeHealthy) {
      if (!activation.opts.json) {
        defaultRuntime.log(theme.success("Gateway: restarted and verified."));
      }
      return true;
    }

    const diagnosticLines = [
      "Gateway did not become healthy after restart.",
      ...(health.healthy && opts.requireRunningService
        ? ["Gateway responded, but the managed service did not report running after restart."]
        : []),
      ...renderRestartDiagnostics(health),
      ...(launchAgentRecovery?.attempted
        ? [
            launchAgentRecovery.recovered
              ? `LaunchAgent recovery: ${launchAgentRecovery.message}`
              : `LaunchAgent recovery failed: ${launchAgentRecovery.detail}`,
          ]
        : []),
      `Restart log: ${resolveGatewayRestartLogPath(activation.serviceEnv ?? process.env)}`,
      `Run \`${replaceCliName(formatCliCommand("openclaw gateway status --deep"), CLI_NAME)}\` for details.`,
      ...formatPostUpdateGatewayRecoveryInstructions(activation.result),
    ];
    if (activation.opts.json) {
      defaultRuntime.error(diagnosticLines.join("\n"));
    } else {
      defaultRuntime.log(theme.warn(diagnosticLines[0] ?? "Gateway did not become healthy."));
      for (const line of diagnosticLines.slice(1)) {
        defaultRuntime.log(theme.muted(line));
      }
    }

    if (requiresVerifiedRestart() || opts.requireRunningService) {
      return false;
    }

    return !(
      health.versionMismatch ||
      health.buildIdMismatch ||
      health.activatedPluginErrors?.length
    );
  };

  if (activation.shouldRestart) {
    if (!activation.opts.json) {
      defaultRuntime.log("");
      defaultRuntime.log(theme.heading("Restarting service..."));
    }

    try {
      let expectedGatewayVersion = requiresVerifiedRestart()
        ? normalizeOptionalString(activation.result.after?.version)
        : undefined;
      const expectedGatewayBuildId =
        activation.channel === "dev" && activation.result.mode === "git"
          ? normalizeOptionalString(activation.result.after?.buildId)
          : undefined;
      const canVerifyUpdatedGatewayByVersion =
        expectedGatewayVersion !== undefined &&
        expectedGatewayVersion !== normalizeOptionalString(activation.result.before?.version);
      let restarted = false;
      let restartInitiated = false;
      let refreshedGatewayAlreadyHealthy = false;
      let updatedInstallRestartNeedsServiceRootProof = false;
      let restartScriptPath = preserveDefinition ? null : activation.restartScriptPath;
      if (activation.refreshServiceEnv && activation.serviceInstallEnv !== null) {
        try {
          await runUpdatedInstallGatewayCommand(activation, "install");
          if (isPackageUpdate && expectedGatewayVersion) {
            const health = await waitForGatewayHealthyRestart({
              service: resolveGatewayService(),
              port: activation.gatewayPort,
              expectedVersion: expectedGatewayVersion,
              env: activation.serviceEnv,
              attempts: POST_REFRESH_ALREADY_HEALTHY_ATTEMPTS,
              delayMs: POST_REFRESH_ALREADY_HEALTHY_DELAY_MS,
            });
            refreshedGatewayAlreadyHealthy = health.healthy;
            if (refreshedGatewayAlreadyHealthy && !activation.opts.json) {
              defaultRuntime.log(
                theme.muted(
                  "Gateway already reports the updated version after service refresh; skipped redundant restart.",
                ),
              );
            }
          }
        } catch (err) {
          defaultRuntime.error(
            `Failed to refresh gateway service environment from updated install: ${String(err)}`,
          );
          if (DEFINITION_DENIAL.test(String(err))) {
            // A writer denial is not a lifecycle grant: revalidate the retained
            // command and manager before using native activation without repair.
            preserveDefinition = true;
            if (verdict?.kind !== "owned") {
              throw err;
            }
            const state = await readGatewayServiceState(resolveGatewayService(), {
              env: activation.serviceEnv,
              requireEffective: true,
              validateEnvBeforeStatusRead: assertGatewayServiceManagementAllowedForUpdate,
              timeoutMs: activation.timeoutMs,
            });
            await revalidateManagedGatewayServiceAfterUpdate({
              state,
              root: activation.result.root ?? verdict.root,
              preManagedServiceStop: {
                serviceEnv: activation.serviceEnv,
                serviceUpdateVerdict: { ...verdict, refreshDefinition: false },
              },
            });
            activation = {
              ...activation,
              serviceEnv: state.env,
              gatewayPort: await resolveUpdatedGatewayRestartPort({
                serviceEnv: state.env,
                serviceCommand: state.command,
              }),
            };
            expectedGatewayVersion = normalizeOptionalString(activation.result.after?.version);
            restartScriptPath = null;
          }
          if (isPackageUpdate) {
            restartScriptPath = null;
            updatedInstallRestartNeedsServiceRootProof = !canVerifyUpdatedGatewayByVersion;
          }
        }
      }
      // Service refresh can bootstrap a RunAtLoad LaunchAgent directly. When
      // that already produced the expected gateway version, a second kickstart
      // would only race the healthy supervisor-owned process.
      if (!refreshedGatewayAlreadyHealthy && restartScriptPath) {
        await createUpdateConfigSnapshot();
        await runRestartScript(restartScriptPath);
        restartInitiated = true;
      } else if (!refreshedGatewayAlreadyHealthy && canRestartUpdatedInstall()) {
        await createUpdateConfigSnapshot();
        restarted = await runUpdatedInstallGatewayCommand(
          activation,
          "restart",
          preserveDefinition,
        );
        if (
          updatedInstallRestartNeedsServiceRootProof &&
          (await gatewayServiceCommandUsesRoot({
            root: activation.result.root,
            env: activation.serviceEnv,
          })) !== true
        ) {
          if (!activation.opts.json) {
            defaultRuntime.log(
              theme.warn("Gateway service did not point at the updated install after restart."),
            );
          }
          return false;
        }
      } else if (
        !refreshedGatewayAlreadyHealthy &&
        shouldUseLegacyProcessRestartAfterUpdate({ updateMode: activation.result.mode }) &&
        !activation.skipLegacyServiceRestart
      ) {
        await createUpdateConfigSnapshot();
        restarted = await runDaemonRestart();
      } else if (!refreshedGatewayAlreadyHealthy && !activation.opts.json) {
        defaultRuntime.log(theme.muted("Gateway: restart skipped (no installed service found)."));
      }

      const shouldVerifyRestart =
        refreshedGatewayAlreadyHealthy ||
        restartInitiated ||
        (restarted &&
          (preserveDefinition ||
            expectedGatewayVersion !== undefined ||
            activation.result.mode === "git")) ||
        activation.requireRunningServiceAfterRestart;
      if (shouldVerifyRestart) {
        const requireRunningService =
          updatedInstallRestartNeedsServiceRootProof ||
          activation.requireRunningServiceAfterRestart;
        const restartHealthy = await verifyRestartedGateway(
          expectedGatewayVersion,
          expectedGatewayBuildId,
          { requireRunningService },
        );
        if (!restartHealthy) {
          if (!activation.opts.json) {
            defaultRuntime.log("");
          }
          return false;
        }
        if (!activation.opts.json && restartInitiated) {
          defaultRuntime.log(theme.success("Daemon restart completed."));
          defaultRuntime.log("");
        }
      }

      if (!activation.opts.json && restarted && !preserveDefinition) {
        defaultRuntime.log(theme.success("Daemon restarted successfully."));
        defaultRuntime.log("");
        await createUpdateConfigSnapshot();
        process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
        process.env[UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV] = "1";
        try {
          const interactiveDoctor =
            process.stdin.isTTY && !activation.opts.json && activation.opts.yes !== true;
          await doctorCommand(defaultRuntime, {
            nonInteractive: !interactiveDoctor,
          });
        } catch (err) {
          defaultRuntime.log(theme.warn(`Doctor failed: ${String(err)}`));
        } finally {
          delete process.env.OPENCLAW_UPDATE_IN_PROGRESS;
          delete process.env[UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV];
        }
      }
    } catch (err) {
      defaultRuntime.error(
        `Gateway: restart failed: ${String(err)}. Code update remains installed; a service stopped for update may still be stopped. ` +
          "Run `openclaw gateway status --deep` and ask its service owner to restart it manually.",
      );
      if (requiresVerifiedRestart()) {
        return false;
      }
    }
    return true;
  }

  if (!activation.opts.json) {
    defaultRuntime.log("");
    defaultRuntime.log(theme.muted("Gateway: restart skipped (--no-restart)."));
    if (activation.result.mode === "npm" || activation.result.mode === "pnpm") {
      defaultRuntime.log(
        theme.muted(
          `Tip: Run \`${replaceCliName(formatCliCommand("openclaw doctor"), CLI_NAME)}\`, then \`${replaceCliName(formatCliCommand("openclaw gateway restart"), CLI_NAME)}\` to apply updates to a running gateway.`,
        ),
      );
    } else {
      defaultRuntime.log(
        theme.muted(
          `Tip: Run \`${replaceCliName(formatCliCommand("openclaw gateway restart"), CLI_NAME)}\` to apply updates to a running gateway.`,
        ),
      );
    }
  }
  return true;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
