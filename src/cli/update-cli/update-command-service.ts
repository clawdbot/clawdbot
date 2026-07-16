// Managed gateway service lifecycle before and after an update.
import fs from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { confirm, isCancel } from "@clack/prompts";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { stylePromptMessage } from "../../../packages/terminal-core/src/prompt-style.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import {
  checkShellCompletionStatus,
  ensureCompletionCacheExists,
} from "../../commands/doctor-completion.js";
import { DOCTOR_DISABLE_CROSS_STATE_DIR_IMPORTS_ENV } from "../../commands/doctor-invocation.js";
import { doctorCommand } from "../../commands/doctor.js";
import { UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV } from "../../commands/doctor/shared/update-phase.js";
import { resolveGatewayPort } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  GATEWAY_SERVICE_KIND,
  GATEWAY_SERVICE_MARKER,
  GATEWAY_SERVICE_RUNTIME_PID_ENV,
} from "../../daemon/constants.js";
import { resolveGatewayInstallEntrypoint } from "../../daemon/gateway-entrypoint.js";
import { resolveGatewayRestartLogPath } from "../../daemon/restart-logs.js";
import {
  resumeScheduledTaskAutoStartAfterUpdate,
  suspendScheduledTaskAutoStartForUpdate,
} from "../../daemon/schtasks.js";
import { summarizeGatewayServiceLayout } from "../../daemon/service-layout.js";
import type { GatewayServiceCommandConfig } from "../../daemon/service-types.js";
import {
  readGatewayServiceState,
  resolveGatewayService,
  type GatewayService,
} from "../../daemon/service.js";
import { parseStrictPositiveInteger } from "../../infra/parse-finite-number.js";
import { getSelfAndAncestorPidsSync } from "../../infra/restart-stale-pids.js";
import { nodeVersionSatisfiesEngine } from "../../infra/runtime-guard.js";
import { fetchNpmPackageTargetStatus } from "../../infra/update-check.js";
import { canResolveRegistryVersionForPackageTarget } from "../../infra/update-global.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { replaceCliName, resolveCliName } from "../cli-name.js";
import { formatCliCommand } from "../command-format.js";
import { installCompletion } from "../completion-runtime.js";
import { runDaemonInstall, runDaemonRestart } from "../daemon-cli.js";
import { recoverInstalledLaunchAgent } from "../daemon-cli/launchd-recovery.js";
import {
  renderRestartDiagnostics,
  terminateStaleGatewayPids,
  waitForGatewayHealthyRestart,
  type GatewayRestartSnapshot,
} from "../daemon-cli/restart-health.js";
import {
  registerSignalExitBarrier,
  registerSignalExitGate,
  waitForSignalExitBarriers,
} from "../signal-exit-barrier.js";
import { runRestartScript } from "./restart-helper.js";
import { resolveNodeRunner, type UpdateCommandOptions } from "./shared.js";
import { createUpdateConfigSnapshot } from "./update-command-config.js";

const CLI_NAME = resolveCliName();
const SERVICE_REFRESH_TIMEOUT_MS = 60_000;
const POST_REFRESH_ALREADY_HEALTHY_ATTEMPTS = 10;
const POST_REFRESH_ALREADY_HEALTHY_DELAY_MS = 500;
const SERVICE_REFRESH_PATH_ENV_KEYS = [
  "OPENCLAW_HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
] as const;
const POST_INSTALL_DOCTOR_SERVICE_ENV_KEYS = [
  ...SERVICE_REFRESH_PATH_ENV_KEYS,
  "OPENCLAW_PROFILE",
] as const;
const JSON_MODE_SERVICE_STDOUT = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

export function isPackageManagerUpdateMode(
  mode: UpdateRunResult["mode"],
): mode is "npm" | "pnpm" | "bun" {
  return mode === "npm" || mode === "pnpm" || mode === "bun";
}

export function shouldPrepareUpdatedInstallRestart(params: {
  updateMode: UpdateRunResult["mode"];
  serviceInstalled: boolean;
  serviceLoaded: boolean;
  serviceStoppedForUpdate?: boolean;
  serviceMatchesMutationRoot?: boolean;
  serviceMatchesUpdateRoot?: boolean;
}): boolean {
  if (params.serviceMatchesMutationRoot === false) {
    return false;
  }
  if (isPackageManagerUpdateMode(params.updateMode)) {
    return params.serviceInstalled;
  }
  if (params.updateMode === "git" && params.serviceStoppedForUpdate) {
    return params.serviceInstalled;
  }
  if (params.updateMode === "git") {
    return params.serviceLoaded && params.serviceMatchesUpdateRoot === true;
  }
  return params.serviceLoaded;
}

function shouldUseLegacyProcessRestartAfterUpdate(params: {
  updateMode: UpdateRunResult["mode"];
}): boolean {
  return !isPackageManagerUpdateMode(params.updateMode);
}

type PostUpdateLaunchAgentRecoveryResult =
  | { attempted: false; recovered: false }
  | { attempted: true; recovered: true; message: string }
  | { attempted: true; recovered: false; detail: string };

type PostUpdateLaunchAgentRecoveryDeps = {
  platform?: NodeJS.Platform;
  readState?: typeof readGatewayServiceState;
  recover?: typeof recoverInstalledLaunchAgent;
};

async function recoverInstalledLaunchAgentAfterUpdate(params: {
  service?: GatewayService;
  env?: NodeJS.ProcessEnv;
  deps?: PostUpdateLaunchAgentRecoveryDeps;
}): Promise<PostUpdateLaunchAgentRecoveryResult> {
  const platform = params.deps?.platform ?? process.platform;
  if (platform !== "darwin") {
    return { attempted: false, recovered: false };
  }

  const service = params.service ?? resolveGatewayService();
  const readState = params.deps?.readState ?? readGatewayServiceState;
  const recover = params.deps?.recover ?? recoverInstalledLaunchAgent;
  const state = await readState(service, { env: params.env }).catch(() => null);
  if (state?.loaded) {
    return { attempted: false, recovered: false };
  }
  if (state && !state.installed && !state.runtime?.missingSupervision) {
    return { attempted: false, recovered: false };
  }

  const recovered = await recover({ result: "restarted", env: state?.env ?? params.env }).catch(
    () => null,
  );
  if (!recovered) {
    return {
      attempted: true,
      recovered: false,
      detail:
        "LaunchAgent was installed but not loaded; automatic bootstrap/kickstart recovery failed.",
    };
  }

  return {
    attempted: true,
    recovered: true,
    message: recovered.message,
  };
}

type PostUpdateGatewayHealthRecoveryDeps = {
  recoverLaunchAgent?: typeof recoverInstalledLaunchAgentAfterUpdate;
  waitForHealthy?: typeof waitForGatewayHealthyRestart;
};

async function recoverLaunchAgentAndRecheckGatewayHealth(params: {
  health: GatewayRestartSnapshot;
  service: GatewayService;
  port: number;
  expectedVersion?: string;
  env?: NodeJS.ProcessEnv;
  deps?: PostUpdateGatewayHealthRecoveryDeps;
}): Promise<{
  health: GatewayRestartSnapshot;
  launchAgentRecovery: PostUpdateLaunchAgentRecoveryResult | null;
}> {
  if (params.health.healthy) {
    return { health: params.health, launchAgentRecovery: null };
  }

  const recoverLaunchAgent =
    params.deps?.recoverLaunchAgent ?? recoverInstalledLaunchAgentAfterUpdate;
  const launchAgentRecovery = await recoverLaunchAgent({
    service: params.service,
    env: params.env,
  });
  if (!launchAgentRecovery.recovered) {
    return { health: params.health, launchAgentRecovery };
  }

  const waitForHealthy = params.deps?.waitForHealthy ?? waitForGatewayHealthyRestart;
  const health = await waitForHealthy({
    service: params.service,
    port: params.port,
    expectedVersion: params.expectedVersion,
    env: params.env,
  });
  return { health, launchAgentRecovery };
}

function formatPostUpdateGatewayRecoveryLine(platform: NodeJS.Platform): string {
  const restartCommand = replaceCliName(formatCliCommand("openclaw gateway restart"), CLI_NAME);
  const installCommand = replaceCliName(
    formatCliCommand("openclaw gateway install --force"),
    CLI_NAME,
  );
  const statusCommand = replaceCliName(
    formatCliCommand("openclaw gateway status --deep"),
    CLI_NAME,
  );
  if (platform === "darwin") {
    return `Recovery: run \`${restartCommand}\`; if the LaunchAgent is installed but not loaded, run \`${installCommand}\` from the logged-in macOS user session, then rerun \`${statusCommand}\`.`;
  }
  if (platform === "linux") {
    return `Recovery: run \`${restartCommand}\`; if the systemd user service is missing, stale, or not active, run \`${installCommand}\` from the same user account, then rerun \`${statusCommand}\`.`;
  }
  if (platform === "win32") {
    return `Recovery: run \`${restartCommand}\`; if the gateway Scheduled Task or Windows login item is missing, stale, or not running, run \`${installCommand}\` from the same user account, then rerun \`${statusCommand}\`.`;
  }
  return `Recovery: run \`${restartCommand}\`; if the local service manager reports the gateway service is missing, stale, or not running, run \`${installCommand}\` from the same user account, then rerun \`${statusCommand}\`.`;
}

function formatPostUpdateGatewayRecoveryInstructions(
  result: UpdateRunResult,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const lines = [formatPostUpdateGatewayRecoveryLine(platform)];
  const beforeVersion = normalizeOptionalString(result.before?.version);
  if (isPackageManagerUpdateMode(result.mode) && beforeVersion) {
    lines.push(
      `Rollback: reinstall OpenClaw ${beforeVersion} with the same package manager, then rerun \`${replaceCliName(formatCliCommand("openclaw gateway install --force"), CLI_NAME)}\`.`,
    );
  }
  return lines;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.updateCommandServiceTestApi")] =
    {
      formatPostUpdateGatewayRecoveryInstructions,
      recoverInstalledLaunchAgentAfterUpdate,
      recoverLaunchAgentAndRecheckGatewayHealth,
      shouldUseLegacyProcessRestartAfterUpdate,
    };
}

export type PreManagedServiceStop = {
  stopped: boolean;
  inspected: boolean;
  runtimeInspected: boolean;
  running: boolean;
  serviceMatchesMutationRoot?: boolean;
  blockMessage?: string;
  serviceEnv?: NodeJS.ProcessEnv;
  windowsTaskAutoStartRecovery?: WindowsTaskAutoStartRecovery;
};

type WindowsTaskAutoStartRecovery = {
  suspended: Promise<boolean>;
  restore: () => Promise<void>;
  complete: () => void;
  interrupted: () => boolean;
};

export type UpdateCommandRecoveryState = {
  windowsTaskAutoStartRecovery?: WindowsTaskAutoStartRecovery;
};

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

function formatGatewayAncestryBlockMessage(pid: number): string {
  return `openclaw update detected it is running inside the gateway process tree.
Gateway PID ${pid} is an ancestor of this process, so this updater cannot safely stop or restart the gateway that owns it.
Run \`${replaceCliName(formatCliCommand("openclaw update"), CLI_NAME)}\` from a shell outside the gateway service, or stop the gateway service first and then update.`;
}

function parsePositivePid(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) {
    return null;
  }
  return parseStrictPositiveInteger(trimmed) ?? null;
}

function isInheritedGatewayRuntimePid(
  pid: number,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!isRunningInsideGatewayService(env)) {
    return false;
  }
  return parsePositivePid(env[GATEWAY_SERVICE_RUNTIME_PID_ENV]) === pid;
}

function isGatewayAncestorPid(
  pid: unknown,
  env: Record<string, string | undefined> = process.env,
): pid is number {
  const parsed = parsePositivePid(pid);
  if (parsed === null) {
    return false;
  }
  return isInheritedGatewayRuntimePid(parsed, env) || getSelfAndAncestorPidsSync().has(parsed);
}

function gatewayAncestryBlockMessage(pid: unknown): string | undefined {
  return isGatewayAncestorPid(pid) ? formatGatewayAncestryBlockMessage(pid) : undefined;
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
}): Promise<PreManagedServiceStop> {
  let service: ReturnType<typeof resolveGatewayService>;
  let serviceState: Awaited<ReturnType<typeof readGatewayServiceState>>;
  try {
    service = resolveGatewayService();
    serviceState = await readGatewayServiceState(service, { env: process.env });
  } catch {
    return { stopped: false, inspected: false, runtimeInspected: false, running: false };
  }

  const runtimeStatus = serviceState.runtime?.status;
  const runtimeInspected = runtimeStatus === "running" || runtimeStatus === "stopped";
  if (!serviceState.installed) {
    return {
      stopped: false,
      inspected: true,
      runtimeInspected,
      running: serviceState.running,
      serviceEnv: serviceState.env,
    };
  }

  const serviceMatchesMutationRoot = await gatewayServiceCommandUsesRoot({
    root: params.root,
    command: serviceState.command,
  });
  const serviceOwnership =
    serviceMatchesMutationRoot === null ? {} : { serviceMatchesMutationRoot };

  if (!params.shouldRestart) {
    if (!params.jsonMode && serviceState.running) {
      defaultRuntime.log(
        theme.warn(
          `--no-restart is set while the managed gateway service is running; the ${params.updateInstallKind} update will not stop or restart that process.`,
        ),
      );
    }
    const windowsTaskAutoStartRecovery = isRunningInsideGatewayService()
      ? undefined
      : await maybeSuspendWindowsTaskAutoStartForPackageUpdate({
          updateInstallKind: params.updateInstallKind,
          serviceEnv: serviceState.env,
        });
    return {
      stopped: false,
      inspected: true,
      runtimeInspected,
      running: serviceState.running,
      ...serviceOwnership,
      serviceEnv: serviceState.env,
      ...(windowsTaskAutoStartRecovery ? { windowsTaskAutoStartRecovery } : {}),
    };
  }

  if (!runtimeInspected) {
    // An inherited gateway process cannot safely update and will be rejected below.
    // Do not leave its task disabled while returning that rejection.
    const windowsTaskAutoStartRecovery = isRunningInsideGatewayService()
      ? undefined
      : await maybeSuspendWindowsTaskAutoStartForPackageUpdate({
          updateInstallKind: params.updateInstallKind,
          serviceEnv: serviceState.env,
        });
    return {
      stopped: false,
      inspected: true,
      runtimeInspected: false,
      running: false,
      ...serviceOwnership,
      serviceEnv: serviceState.env,
      ...(windowsTaskAutoStartRecovery ? { windowsTaskAutoStartRecovery } : {}),
    };
  }

  if (!serviceState.running) {
    const windowsTaskAutoStartRecovery = await maybeSuspendWindowsTaskAutoStartForPackageUpdate({
      updateInstallKind: params.updateInstallKind,
      serviceEnv: serviceState.env,
    });
    return {
      stopped: false,
      inspected: true,
      runtimeInspected: true,
      running: false,
      ...serviceOwnership,
      serviceEnv: serviceState.env,
      ...(windowsTaskAutoStartRecovery ? { windowsTaskAutoStartRecovery } : {}),
    };
  }

  const blockMessage = gatewayAncestryBlockMessage(serviceState.runtime?.pid);
  if (blockMessage) {
    return {
      stopped: false,
      inspected: true,
      runtimeInspected: true,
      running: true,
      ...serviceOwnership,
      blockMessage,
      serviceEnv: serviceState.env,
    };
  }

  if (serviceMatchesMutationRoot === false) {
    if (!params.jsonMode) {
      defaultRuntime.log(
        theme.muted(
          `Managed gateway service points at a different OpenClaw root; leaving it running during this ${params.updateInstallKind} update.`,
        ),
      );
    }
    return {
      stopped: false,
      inspected: true,
      runtimeInspected: true,
      running: true,
      ...serviceOwnership,
      serviceEnv: serviceState.env,
    };
  }

  if (!params.jsonMode) {
    defaultRuntime.log(
      theme.muted(`Stopping managed gateway service before ${params.updateInstallKind} update...`),
    );
  }
  const windowsTaskAutoStartRecovery = await maybeSuspendWindowsTaskAutoStartForPackageUpdate({
    updateInstallKind: params.updateInstallKind,
    serviceEnv: serviceState.env,
  });
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
    stopped: true,
    inspected: true,
    runtimeInspected: true,
    running: true,
    ...serviceOwnership,
    serviceEnv: serviceState.env,
    ...(windowsTaskAutoStartRecovery ? { windowsTaskAutoStartRecovery } : {}),
  };
}

export async function maybeRestartServiceAfterFailedMutableUpdate(params: {
  preManagedServiceStop: PreManagedServiceStop | undefined;
  jsonMode: boolean;
}): Promise<void> {
  if (!params.preManagedServiceStop?.stopped || !params.preManagedServiceStop.serviceEnv) {
    return;
  }
  try {
    await resolveGatewayService().restart({
      env: params.preManagedServiceStop.serviceEnv,
      stdout: serviceControlStdoutForMode(params.jsonMode),
    });
    if (!params.jsonMode) {
      defaultRuntime.log(theme.muted("Restarted managed gateway service after failed update."));
    }
  } catch (err) {
    const message = `Failed to restart managed gateway service after failed update: ${String(err)}`;
    if (params.jsonMode) {
      defaultRuntime.error(message);
    } else {
      defaultRuntime.log(theme.warn(message));
    }
  }
}

function isRunningInsideGatewayService(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.OPENCLAW_SERVICE_MARKER?.trim() !== GATEWAY_SERVICE_MARKER) {
    return false;
  }
  const serviceKind = env.OPENCLAW_SERVICE_KIND?.trim();
  return !serviceKind || serviceKind === GATEWAY_SERVICE_KIND;
}

export function shouldBlockMutableUpdateFromGatewayServiceEnv(params: {
  preManagedServiceStop: PreManagedServiceStop | undefined;
}): boolean {
  if (!isRunningInsideGatewayService()) {
    return false;
  }
  const stopState = params.preManagedServiceStop;
  if (!stopState?.inspected) {
    return true;
  }
  if (stopState.stopped) {
    return false;
  }
  if (!stopState.runtimeInspected) {
    return true;
  }
  return stopState.running;
}

function formatCommandFailure(stdout: string, stderr: string): string {
  const detail = (stderr || stdout).trim();
  if (!detail) {
    return "command returned a non-zero exit code";
  }
  return detail.split("\n").slice(-3).join("\n");
}

export function tryResolveInvocationCwd(): string | undefined {
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
}

export async function resolvePackageRuntimePreflightError(params: {
  tag: string;
  timeoutMs?: number;
  nodeRunner?: string;
  spec?: string;
  command?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string | null> {
  if (!canResolveRegistryVersionForPackageTarget(params.tag)) {
    return null;
  }
  if (params.spec && !canResolveRegistryVersionForPackageTarget(params.spec)) {
    return null;
  }
  const target = params.tag.trim();
  if (!target) {
    return null;
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
    return null;
  }
  const runtime = await resolvePackageRuntimeForPreflight({
    nodeRunner: params.nodeRunner,
    timeoutMs: params.timeoutMs,
  });
  const satisfies = nodeVersionSatisfiesEngine(runtime.version, status.nodeEngine);
  if (satisfies !== false) {
    return null;
  }
  const targetLabel = status.version ?? target;
  const runtimeLabel = runtime.nodeRunner
    ? `Node ${runtime.version ?? "unknown"} at ${runtime.nodeRunner}`
    : `Node ${runtime.version ?? "unknown"}`;
  return [
    `${runtimeLabel} is too old for openclaw@${targetLabel}.`,
    `The requested package requires ${status.nodeEngine}.`,
    runtime.nodeRunner
      ? "Upgrade the Node runtime that owns the managed Gateway service, then rerun `openclaw update`."
      : "Upgrade to Node 22.22.3+, Node 24.15.0+, or Node 25.9.0+, then rerun `openclaw update`.",
    "Bare `npm i -g openclaw` can silently install an older compatible release.",
    "After upgrading Node, use `npm i -g openclaw@latest`.",
  ].join("\n");
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
  const rawVersion = res?.code === 0 ? res.stdout.trim() : "";
  const version = rawVersion.replace(/^v/u, "") || null;
  return { version, nodeRunner };
}

function resolveServiceRefreshEnv(
  env: NodeJS.ProcessEnv,
  invocationCwd?: string,
): NodeJS.ProcessEnv {
  const resolvedEnv: NodeJS.ProcessEnv = { ...env };
  for (const key of SERVICE_REFRESH_PATH_ENV_KEYS) {
    const rawValue = resolvedEnv[key]?.trim();
    if (!rawValue) {
      continue;
    }
    if (rawValue.startsWith("~") || path.isAbsolute(rawValue) || path.win32.isAbsolute(rawValue)) {
      resolvedEnv[key] = rawValue;
      continue;
    }
    if (!invocationCwd) {
      resolvedEnv[key] = rawValue;
      continue;
    }
    resolvedEnv[key] = path.resolve(invocationCwd, rawValue);
  }
  return resolvedEnv;
}

export function disableUpdatedPackageCompileCacheEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    NODE_DISABLE_COMPILE_CACHE: "1",
  };
}

export function stripGatewayServiceMarkerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const resolvedEnv = { ...env };
  delete resolvedEnv.OPENCLAW_SERVICE_MARKER;
  delete resolvedEnv.OPENCLAW_SERVICE_KIND;
  delete resolvedEnv[GATEWAY_SERVICE_RUNTIME_PID_ENV];
  return resolvedEnv;
}

function resolveUpdatedInstallCommandEnv(
  env: NodeJS.ProcessEnv,
  invocationCwd?: string,
): NodeJS.ProcessEnv {
  return disableUpdatedPackageCompileCacheEnv(resolveServiceRefreshEnv(env, invocationCwd));
}

export function resolvePostInstallDoctorEnv(params?: {
  baseEnv?: NodeJS.ProcessEnv;
  serviceEnv?: NodeJS.ProcessEnv;
  invocationCwd?: string;
}): NodeJS.ProcessEnv {
  const resolvedEnv: NodeJS.ProcessEnv = {
    ...disableUpdatedPackageCompileCacheEnv(params?.baseEnv ?? process.env),
    [DOCTOR_DISABLE_CROSS_STATE_DIR_IMPORTS_ENV]: "1",
  };
  if (!params?.serviceEnv) {
    return resolvedEnv;
  }

  const serviceEnv = resolveServiceRefreshEnv(params.serviceEnv, params.invocationCwd);
  for (const key of POST_INSTALL_DOCTOR_SERVICE_ENV_KEYS) {
    const value = serviceEnv[key]?.trim();
    if (value) {
      resolvedEnv[key] = serviceEnv[key];
    }
  }
  return resolvedEnv;
}

export function resolveUpdatedGatewayRestartPort(params: {
  config?: OpenClawConfig;
  processEnv?: NodeJS.ProcessEnv;
  serviceEnv?: NodeJS.ProcessEnv;
}): number {
  return resolveGatewayPort(params.config, params.serviceEnv ?? params.processEnv ?? process.env);
}

export function resolvePostUpdateServiceStateReadEnv(params: {
  updateMode: UpdateRunResult["mode"];
  processEnv?: NodeJS.ProcessEnv;
  preManagedServiceEnv?: NodeJS.ProcessEnv;
  prePackageServiceEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  if (params.updateMode === "git" && params.preManagedServiceEnv) {
    return params.preManagedServiceEnv;
  }
  if (isPackageManagerUpdateMode(params.updateMode)) {
    return (
      params.preManagedServiceEnv ?? params.prePackageServiceEnv ?? params.processEnv ?? process.env
    );
  }
  return params.processEnv ?? process.env;
}

async function refreshGatewayServiceEnv(params: {
  result: UpdateRunResult;
  jsonMode: boolean;
  invocationCwd?: string;
  env?: NodeJS.ProcessEnv;
  nodeRunner?: string;
}): Promise<void> {
  const args = ["gateway", "install", "--force"];
  if (params.jsonMode) {
    args.push("--json");
  }

  const entrypoint = await resolveGatewayInstallEntrypoint(params.result.root);
  if (entrypoint) {
    const res = await runCommandWithTimeout(
      [params.nodeRunner ?? resolveNodeRunner(), entrypoint, ...args],
      {
        cwd: params.result.root,
        env: resolveUpdatedInstallCommandEnv(params.env ?? process.env, params.invocationCwd),
        timeoutMs: SERVICE_REFRESH_TIMEOUT_MS,
      },
    );
    if (res.code === 0) {
      return;
    }
    throw new Error(
      `updated install refresh failed (${entrypoint}): ${formatCommandFailure(res.stdout, res.stderr)}`,
    );
  }

  if (isPackageManagerUpdateMode(params.result.mode)) {
    throw new Error(
      `updated install entrypoint not found under ${params.result.root ?? "unknown"}`,
    );
  }

  await runDaemonInstall({ force: true, json: params.jsonMode || undefined });
}

async function runUpdatedInstallGatewayRestart(params: {
  result: UpdateRunResult;
  jsonMode: boolean;
  invocationCwd?: string;
  env?: NodeJS.ProcessEnv;
  nodeRunner?: string;
}): Promise<boolean> {
  const entrypoint = await resolveGatewayInstallEntrypoint(params.result.root);
  if (!entrypoint) {
    throw new Error(
      `updated install entrypoint not found under ${params.result.root ?? "unknown"}`,
    );
  }

  const args = ["gateway", "restart"];
  if (params.jsonMode) {
    args.push("--json");
  }
  const res = await runCommandWithTimeout(
    [params.nodeRunner ?? resolveNodeRunner(), entrypoint, ...args],
    {
      cwd: params.result.root,
      env: resolveUpdatedInstallCommandEnv(params.env ?? process.env, params.invocationCwd),
      timeoutMs: SERVICE_REFRESH_TIMEOUT_MS,
    },
  );
  if (res.code === 0) {
    return true;
  }
  throw new Error(
    `updated install restart failed (${entrypoint}): ${formatCommandFailure(res.stdout, res.stderr)}`,
  );
}

export async function tryInstallShellCompletion(opts: {
  jsonMode: boolean;
  skipPrompt: boolean;
}): Promise<void> {
  if (opts.jsonMode || !process.stdin.isTTY) {
    return;
  }

  const status = await checkShellCompletionStatus(CLI_NAME);
  const generationOptions = { generationMode: "core-only" } as const;

  if (status.usesSlowPattern) {
    defaultRuntime.log(theme.muted("Upgrading shell completion to cached version..."));
    const cacheGenerated = await ensureCompletionCacheExists(CLI_NAME, generationOptions);
    if (cacheGenerated) {
      await installShellCompletionForUpdate(status.shell, true);
    }
    return;
  }

  if (status.profileInstalled && !status.cacheExists) {
    defaultRuntime.log(theme.muted("Regenerating shell completion cache..."));
    await ensureCompletionCacheExists(CLI_NAME, generationOptions);
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

    const cacheGenerated = await ensureCompletionCacheExists(CLI_NAME, generationOptions);
    if (!cacheGenerated) {
      defaultRuntime.log(theme.warn("Failed to generate completion cache."));
      return;
    }

    await installShellCompletionForUpdate(status.shell, opts.skipPrompt);
  }
}

async function installShellCompletionForUpdate(shell: string, yes: boolean): Promise<void> {
  try {
    await installCompletion(shell, yes, CLI_NAME);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    defaultRuntime.log(theme.warn(`Shell completion refresh failed: ${message}`));
  }
}

async function tryRealpathOrResolve(value: string): Promise<string> {
  try {
    return await fs.realpath(path.resolve(value));
  } catch {
    return path.resolve(value);
  }
}

function isNodeExecutable(value: string | undefined): boolean {
  const base = normalizeOptionalString(value ? path.basename(value) : undefined)?.toLowerCase();
  return base === "node" || base === "node.exe";
}

function resolveManagedServiceNodeRunner(
  command: GatewayServiceCommandConfig | null,
): string | undefined {
  const args = command?.programArguments;
  if (!args?.length) {
    return undefined;
  }
  const gatewayIndex = args.indexOf("gateway");
  if (gatewayIndex <= 1) {
    return undefined;
  }
  const runner = args[gatewayIndex - 2];
  return isNodeExecutable(runner) ? runner : undefined;
}

/**
 * Resolve the node binary baked into the managed gateway service unit,
 * independent of any package root redirect. This detects when the user's
 * current PATH-resolved node differs from the service's baked node even
 * when the package root is the same.
 */
export async function resolveManagedServiceNodeRunnerOverride(): Promise<string | undefined> {
  const command = await resolveGatewayService()
    .readCommand(process.env)
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
  if (serviceNodeReal === currentNodeReal) {
    return undefined;
  }
  return serviceNode;
}

export async function resolveManagedServicePackageUpdateRoot(params: {
  root: string;
}): Promise<ManagedServiceRootRedirect | null> {
  const command = await resolveGatewayService()
    .readCommand(process.env)
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
      ? await resolveGatewayService()
          .readCommand(params.env ?? process.env)
          .catch(() => null)
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
  return expectedRootReal === serviceRootReal;
}

export async function maybeRestartService(params: {
  shouldRestart: boolean;
  result: UpdateRunResult;
  opts: UpdateCommandOptions;
  refreshServiceEnv: boolean;
  serviceEnv?: NodeJS.ProcessEnv;
  gatewayPort: number;
  restartScriptPath?: string | null;
  invocationCwd?: string;
  nodeRunner?: string;
  skipLegacyServiceRestart?: boolean;
  requireRunningServiceAfterRestart?: boolean;
}): Promise<boolean> {
  const verifyRestartedGateway = async (
    expectedGatewayVersion: string | undefined,
    opts: { requireRunningService?: boolean } = {},
  ) => {
    const restartAfterStaleCleanup = async () => {
      if (params.refreshServiceEnv && isPackageManagerUpdateMode(params.result.mode)) {
        await runUpdatedInstallGatewayRestart({
          result: params.result,
          jsonMode: Boolean(params.opts.json),
          invocationCwd: params.invocationCwd,
          env: params.serviceEnv,
          nodeRunner: params.nodeRunner,
        });
        return;
      }
      if (shouldUseLegacyProcessRestartAfterUpdate({ updateMode: params.result.mode })) {
        await runDaemonRestart();
      }
    };
    const service = resolveGatewayService();
    let health = await waitForGatewayHealthyRestart({
      service,
      port: params.gatewayPort,
      expectedVersion: expectedGatewayVersion,
      env: params.serviceEnv,
      requireRunningService: opts.requireRunningService,
    });
    if (!health.healthy && health.staleGatewayPids.length > 0) {
      if (!params.opts.json) {
        defaultRuntime.log(
          theme.warn(
            `Found stale gateway process(es) after restart: ${health.staleGatewayPids.join(", ")}. Cleaning up...`,
          ),
        );
      }
      await terminateStaleGatewayPids(health.staleGatewayPids);
      await restartAfterStaleCleanup();
      health = await waitForGatewayHealthyRestart({
        service,
        port: params.gatewayPort,
        expectedVersion: expectedGatewayVersion,
        env: params.serviceEnv,
        requireRunningService: opts.requireRunningService,
      });
    }

    const recoveryVerification = await recoverLaunchAgentAndRecheckGatewayHealth({
      health,
      service,
      port: params.gatewayPort,
      expectedVersion: expectedGatewayVersion,
      env: params.serviceEnv,
    });
    health = recoveryVerification.health;
    const launchAgentRecovery = recoveryVerification.launchAgentRecovery;
    if (launchAgentRecovery?.attempted) {
      if (!params.opts.json) {
        defaultRuntime.log(
          launchAgentRecovery.recovered
            ? theme.warn(launchAgentRecovery.message)
            : theme.warn(launchAgentRecovery.detail),
        );
      } else {
        defaultRuntime.error(
          launchAgentRecovery.recovered ? launchAgentRecovery.message : launchAgentRecovery.detail,
        );
      }
    }

    const serviceRuntimeHealthy =
      !opts.requireRunningService || health.runtime.status === "running";
    if (health.healthy && serviceRuntimeHealthy) {
      if (!params.opts.json) {
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
      `Restart log: ${resolveGatewayRestartLogPath(params.serviceEnv ?? process.env)}`,
      `Run \`${replaceCliName(formatCliCommand("openclaw gateway status --deep"), CLI_NAME)}\` for details.`,
      ...formatPostUpdateGatewayRecoveryInstructions(params.result),
    ];
    if (params.opts.json) {
      defaultRuntime.error(diagnosticLines.join("\n"));
    } else {
      defaultRuntime.log(theme.warn(diagnosticLines[0] ?? "Gateway did not become healthy."));
      for (const line of diagnosticLines.slice(1)) {
        defaultRuntime.log(theme.muted(line));
      }
    }

    if (isPackageManagerUpdateMode(params.result.mode) || opts.requireRunningService) {
      return false;
    }

    return !(health.versionMismatch || health.activatedPluginErrors?.length);
  };

  if (params.shouldRestart) {
    if (!params.opts.json) {
      defaultRuntime.log("");
      defaultRuntime.log(theme.heading("Restarting service..."));
    }

    try {
      const expectedGatewayVersion = isPackageManagerUpdateMode(params.result.mode)
        ? normalizeOptionalString(params.result.after?.version)
        : undefined;
      const isPackageUpdate = isPackageManagerUpdateMode(params.result.mode);
      const canVerifyUpdatedGatewayByVersion =
        expectedGatewayVersion !== undefined &&
        expectedGatewayVersion !== normalizeOptionalString(params.result.before?.version);
      let restarted = false;
      let restartInitiated = false;
      let refreshedGatewayAlreadyHealthy = false;
      let updatedInstallRestartNeedsServiceRootProof = false;
      let restartScriptPath = params.restartScriptPath;
      if (params.refreshServiceEnv) {
        try {
          await refreshGatewayServiceEnv({
            result: params.result,
            jsonMode: Boolean(params.opts.json),
            invocationCwd: params.invocationCwd,
            env: params.serviceEnv,
            nodeRunner: params.nodeRunner,
          });
          if (isPackageUpdate && expectedGatewayVersion) {
            const health = await waitForGatewayHealthyRestart({
              service: resolveGatewayService(),
              port: params.gatewayPort,
              expectedVersion: expectedGatewayVersion,
              env: params.serviceEnv,
              attempts: POST_REFRESH_ALREADY_HEALTHY_ATTEMPTS,
              delayMs: POST_REFRESH_ALREADY_HEALTHY_DELAY_MS,
            });
            refreshedGatewayAlreadyHealthy = health.healthy;
            if (refreshedGatewayAlreadyHealthy && !params.opts.json) {
              defaultRuntime.log(
                theme.muted(
                  "Gateway already reports the updated version after service refresh; skipped redundant restart.",
                ),
              );
            }
          }
        } catch (err) {
          // Always log the refresh failure so callers can detect it (issue #56772).
          // Previously this was silently suppressed in --json mode, hiding the root
          // cause and preventing auto-update callers from detecting the failure.
          const message = `Failed to refresh gateway service environment from updated install: ${String(err)}`;
          if (params.opts.json) {
            defaultRuntime.error(message);
          } else {
            defaultRuntime.log(theme.warn(message));
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
      } else if (!refreshedGatewayAlreadyHealthy && params.refreshServiceEnv && isPackageUpdate) {
        await createUpdateConfigSnapshot();
        restarted = await runUpdatedInstallGatewayRestart({
          result: params.result,
          jsonMode: Boolean(params.opts.json),
          invocationCwd: params.invocationCwd,
          env: params.serviceEnv,
          nodeRunner: params.nodeRunner,
        });
        if (
          updatedInstallRestartNeedsServiceRootProof &&
          (await gatewayServiceCommandUsesRoot({
            root: params.result.root,
            env: params.serviceEnv,
          })) !== true
        ) {
          if (!params.opts.json) {
            defaultRuntime.log(
              theme.warn("Gateway service did not point at the updated install after restart."),
            );
          }
          return false;
        }
      } else if (
        !refreshedGatewayAlreadyHealthy &&
        shouldUseLegacyProcessRestartAfterUpdate({ updateMode: params.result.mode }) &&
        !params.skipLegacyServiceRestart
      ) {
        await createUpdateConfigSnapshot();
        restarted = await runDaemonRestart();
      } else if (!refreshedGatewayAlreadyHealthy && !params.opts.json) {
        defaultRuntime.log(theme.muted("Gateway: restart skipped (no installed service found)."));
      }

      const shouldVerifyRestart =
        refreshedGatewayAlreadyHealthy ||
        restartInitiated ||
        (restarted && expectedGatewayVersion !== undefined);
      if (shouldVerifyRestart) {
        const requireRunningService =
          updatedInstallRestartNeedsServiceRootProof || params.requireRunningServiceAfterRestart;
        const restartHealthy = await verifyRestartedGateway(expectedGatewayVersion, {
          requireRunningService,
        });
        if (!restartHealthy) {
          if (!params.opts.json) {
            defaultRuntime.log("");
          }
          return false;
        }
        if (!params.opts.json && restartInitiated) {
          defaultRuntime.log(theme.success("Daemon restart completed."));
          defaultRuntime.log("");
        }
      }

      if (!params.opts.json && restarted) {
        defaultRuntime.log(theme.success("Daemon restarted successfully."));
        defaultRuntime.log("");
        await createUpdateConfigSnapshot();
        process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
        process.env[UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV] = "1";
        try {
          const interactiveDoctor =
            process.stdin.isTTY && !params.opts.json && params.opts.yes !== true;
          await doctorCommand(defaultRuntime, {
            nonInteractive: !interactiveDoctor,
            crossStateDirImports: false,
          });
        } catch (err) {
          defaultRuntime.log(theme.warn(`Doctor failed: ${String(err)}`));
        } finally {
          delete process.env.OPENCLAW_UPDATE_IN_PROGRESS;
          delete process.env[UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV];
        }
      }
    } catch (err) {
      if (!params.opts.json) {
        defaultRuntime.log(theme.warn(`Gateway: restart failed: ${String(err)}`));
        defaultRuntime.log(
          theme.muted(
            `You may need to restart the service manually: ${replaceCliName(formatCliCommand("openclaw gateway restart"), CLI_NAME)}`,
          ),
        );
      }
      if (
        isPackageManagerUpdateMode(params.result.mode) ||
        params.requireRunningServiceAfterRestart
      ) {
        return false;
      }
    }
    return true;
  }

  if (!params.opts.json) {
    defaultRuntime.log("");
    defaultRuntime.log(theme.muted("Gateway: restart skipped (--no-restart)."));
    if (params.result.mode === "npm" || params.result.mode === "pnpm") {
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
