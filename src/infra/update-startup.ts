// Runs startup update checks and optional auto-update handoff.
import { createHash, randomUUID } from "node:crypto";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import {
  asDateTimestampMs,
  timestampMsToIsoString,
} from "@openclaw/normalization-core/number-coercion";
import { sleepWithAbort } from "@openclaw/retry";
import type {
  UpdateAvailable,
  UpdateScheduleState,
} from "../../packages/gateway-protocol/src/index.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  refreshRemoteModelCatalog,
  REMOTE_MODEL_CATALOG_TTL_MS,
} from "../model-catalog/remote-refresh.js";
import { classifyUpdateOutcome } from "../shared/update-outcome.js";
import { readConfigMachineState, writeConfigMachineState } from "../state/config-machine-state.js";
import { VERSION } from "../version.js";
import { isTruthyEnvValue } from "./env.js";
import type { GatewayActiveWorkInspectors } from "./gateway-active-work.js";
import {
  EXTERNAL_SUPERVISOR_UPDATE_REQUIRED_REASON,
  isGatewayExternallySupervised,
} from "./gateway-supervision.js";
import { gitCommitPrefixesMatch } from "./git-commit.js";
import { executeGitCommand } from "./git-exec.js";
import { resolveOpenClawPackageRoot } from "./openclaw-root.js";
import {
  readRestartSentinelSnapshot,
  readVerifiedGitUpdateReceipt,
  writeRestartSentinelIfUnchanged,
  type VerifiedGitUpdateReceipt,
} from "./restart-sentinel.js";
import {
  normalizeGatewayRestartDelayMs,
  resolveGatewayRestartDeferralTimeoutMs,
  scheduleGatewaySigusr1Restart,
} from "./restart.js";
import { detectRespawnSupervisor } from "./supervisor-markers.js";
import { checkTelemetryUpdate } from "./telemetry.js";
import { gatewayUpdateCampaign, type UpdateCampaignController } from "./update-campaign.js";
import {
  channelToNpmTag,
  DEV_BRANCH,
  normalizeUpdateChannel,
  resolveEffectiveUpdateChannel,
  DEFAULT_PACKAGE_CHANNEL,
  type UpdateChannel,
} from "./update-channels.js";
import {
  compareSemverStrings,
  resolveNpmChannelTag,
  checkUpdateStatus,
  type UpdateCheckResult,
} from "./update-check.js";
import { isPendingControlPlaneUpdateRestartSentinel } from "./update-control-plane-sentinel.js";
import { devUpdateTargetFromGitTarget, type TrackedDevUpdateTarget } from "./update-dev-target.js";
import { updateInstallRootsMatch } from "./update-install-root.js";
import {
  buildManagedServiceHandoffUnavailableMessage,
  cancelManagedServiceUpdateHandoff,
  formatManagedServiceUpdateCommand,
  startManagedServiceUpdateHandoff,
} from "./update-managed-service-handoff.js";
import { buildUpdateRestartSentinelPayload } from "./update-restart-sentinel-payload.js";
import { runGatewayUpdatePreflight, type UpdateRunResult } from "./update-runner.js";

type UpdateCheckState = {
  lastCheckedAt?: string;
  lastCheckedChannel?: UpdateChannel;
  lastNotifiedVersion?: string;
  lastNotifiedTag?: string;
  lastAvailableVersion?: string;
  lastAvailableTag?: string;
  autoInstallId?: string;
  autoFirstSeenVersion?: string;
  autoFirstSeenTag?: string;
  autoFirstSeenAt?: string;
  autoLastAttemptVersion?: string;
  autoLastAttemptAt?: string;
};

type AutoUpdatePolicy = {
  enabled: boolean;
  stableDelayHours: number;
  stableJitterHours: number;
  betaCheckIntervalHours: number;
};

type AutoUpdateRunResult =
  | { status: "handoff"; command?: string; logPath?: string }
  | { status: "failed"; result: UpdateRunResult; message: string };

type AutoUpdateRunParams = {
  channel: "stable" | "beta" | "dev";
  mode: UpdateRunResult["mode"];
  timeoutMs: number;
  restartDrainTimeoutMs: number | undefined;
  root?: string;
  packageTargetVersion?: string;
  devTarget?: TrackedDevUpdateTarget;
  signal?: AbortSignal;
};

type AutoUpdateRunner = (params: AutoUpdateRunParams) => Promise<AutoUpdateRunResult>;

export type {
  UpdateAvailable,
  UpdateScheduleState,
} from "../../packages/gateway-protocol/src/index.js";

let updateAvailableCache: UpdateAvailable | null = null;
let updateScheduleCache: UpdateScheduleState | null = null;
type UpdateCheckLifecycle = {
  signal: AbortSignal;
  refreshes: WeakMap<OpenClawConfig, Promise<void>>;
  run: <T>(work: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  initialize: () => ReturnType<typeof resolveStartupInstallStatus>;
  schedule: (work: () => Promise<number>, unref?: boolean) => void;
  stop: () => Promise<void>;
};
let updateCheckLifecycle: UpdateCheckLifecycle | undefined;

function createUpdateCheckLifecycle(
  previous: UpdateCheckLifecycle | undefined = updateCheckLifecycle,
): UpdateCheckLifecycle {
  const predecessor = previous?.stop();
  const controller = new AbortController();
  const { signal } = controller;
  const pending = new Set<Promise<unknown>>();
  let initialization: ReturnType<typeof resolveStartupInstallStatus> | undefined;
  let stopping: Promise<void> | undefined;

  const run = <T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const task = (async () => {
      await predecessor;
      signal.throwIfAborted();
      return await work(signal);
    })();
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return task;
  };
  const initialize = async () => {
    signal.throwIfAborted();
    if (!initialization) {
      const task = run(() => resolveStartupInstallStatus(false, signal));
      initialization = task;
      void task.catch(() => {
        if (initialization === task) {
          initialization = undefined;
        }
      });
    }
    return initialization;
  };
  const schedule = (work: () => Promise<number>, unref = false) => {
    void run(async () => {
      while (!signal.aborted) {
        const delayMs = await work();
        await sleepWithAbort(Math.max(1, delayMs), signal, { ref: !unref });
      }
    }).catch(() => undefined);
  };
  const lifecycle: UpdateCheckLifecycle = {
    signal,
    refreshes: new WeakMap(),
    run,
    initialize,
    schedule,
    stop: () => {
      controller.abort();
      if (updateCheckLifecycle === lifecycle) {
        gatewayUpdateCampaign.clear();
      }
      // Replacement owns the predecessor's drain too. Aborting alone does not
      // join a Git transport or maintenance process that is still shutting down.
      return (stopping ??= Promise.allSettled([predecessor, ...pending]).then(() => undefined));
    },
  };
  return lifecycle;
}

function currentUpdateCheckLifecycle() {
  return (updateCheckLifecycle ??= createUpdateCheckLifecycle());
}

export function getUpdateAvailable(): UpdateAvailable | null {
  return updateAvailableCache;
}

export function getUpdateSchedule(): UpdateScheduleState | null {
  return updateScheduleCache;
}

export async function getUpdateEffectiveChannel(): Promise<UpdateChannel> {
  const { status } = await initializeGatewayUpdateStatus();
  return resolveEffectiveUpdateChannel({
    currentVersion: VERSION,
    installKind: status.installKind,
    git: status.git,
  }).channel;
}

export function resetUpdateAvailableStateForTest(): void {
  updateAvailableCache = null;
  updateScheduleCache = null;
  void updateCheckLifecycle?.stop();
  updateCheckLifecycle = undefined;
  gatewayUpdateCampaign.resetForTest();
}

const UPDATE_CHECK_STATE_KEY = "update.checkState";
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const AUTO_UPDATE_COMMAND_TIMEOUT_MS = 45 * 60 * 1000;
const AUTO_STABLE_DELAY_HOURS_DEFAULT = 6;
const AUTO_STABLE_JITTER_HOURS_DEFAULT = 12;
const AUTO_BETA_CHECK_INTERVAL_HOURS_DEFAULT = 1;
const DEV_COMMIT_LIMIT = 5;
const DEV_COMMIT_SUBJECT_MAX_LENGTH = 120;
const DEV_COMMIT_LOG_MAX_OUTPUT_BYTES = 8 * 1024;

function shouldSkipCheck(allowInTests: boolean): boolean {
  return !allowInTests && Boolean(process.env.VITEST || process.env.NODE_ENV === "test");
}

function resolveAutoUpdatePolicy(cfg: OpenClawConfig): AutoUpdatePolicy {
  const auto = cfg.update?.auto;
  return {
    enabled: Boolean(auto?.enabled),
    stableDelayHours: AUTO_STABLE_DELAY_HOURS_DEFAULT,
    stableJitterHours: AUTO_STABLE_JITTER_HOURS_DEFAULT,
    betaCheckIntervalHours: AUTO_BETA_CHECK_INTERVAL_HOURS_DEFAULT,
  };
}

function resolveCheckIntervalMs(
  cfg: OpenClawConfig,
  installKind?: "package" | "git" | "unknown",
): number {
  const channel = normalizeUpdateChannel(cfg.update?.channel) ?? DEFAULT_PACKAGE_CHANNEL;
  const auto = resolveAutoUpdatePolicy(cfg);
  if (!auto.enabled) {
    return UPDATE_CHECK_INTERVAL_MS;
  }
  if (channel === "beta") {
    return Math.max(ONE_HOUR_MS / 4, Math.floor(auto.betaCheckIntervalHours * ONE_HOUR_MS));
  }
  if (channel === "stable") {
    return ONE_HOUR_MS;
  }
  if (channel === "dev" && installKind === "git") {
    return ONE_HOUR_MS;
  }
  return UPDATE_CHECK_INTERVAL_MS;
}

function readState(): UpdateCheckState {
  return readConfigMachineState<UpdateCheckState>(UPDATE_CHECK_STATE_KEY) ?? {};
}

function writeState(state: UpdateCheckState): void {
  writeConfigMachineState(UPDATE_CHECK_STATE_KEY, state);
}

function sameUpdateAvailable(a: UpdateAvailable | null, b: UpdateAvailable | null): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return (
    a.currentVersion === b.currentVersion &&
    a.latestVersion === b.latestVersion &&
    a.channel === b.channel &&
    a.currentSha === b.currentSha &&
    a.upstreamRef === b.upstreamRef &&
    a.upstreamSha === b.upstreamSha &&
    a.commitsBehind === b.commitsBehind &&
    JSON.stringify(a.commits) === JSON.stringify(b.commits)
  );
}

function sameUpdateSchedule(a: UpdateScheduleState | null, b: UpdateScheduleState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function setUpdateScheduleCache(params: {
  next: UpdateScheduleState;
  onUpdateScheduleChange?: (schedule: UpdateScheduleState) => void;
}): void {
  if (sameUpdateSchedule(updateScheduleCache, params.next)) {
    return;
  }
  updateScheduleCache = params.next;
  params.onUpdateScheduleChange?.(params.next);
}

function withoutCampaign(schedule: UpdateScheduleState): UpdateScheduleState {
  const { campaign: _campaign, ...rest } = schedule;
  return rest;
}

function withoutTarget(schedule: UpdateScheduleState): UpdateScheduleState {
  const { target: _target, campaign: _campaign, ...rest } = schedule;
  return rest;
}

function setUpdateAvailableCache(params: {
  next: UpdateAvailable | null;
  onUpdateAvailableChange?: (updateAvailable: UpdateAvailable | null) => void;
}): void {
  if (sameUpdateAvailable(updateAvailableCache, params.next)) {
    return;
  }
  updateAvailableCache = params.next;
  params.onUpdateAvailableChange?.(params.next);
}

function isPersistedAvailabilityForChannel(params: {
  state: UpdateCheckState;
  channel: UpdateChannel;
}): boolean {
  if (params.state.lastCheckedChannel !== params.channel) {
    return false;
  }
  const tag = params.state.lastAvailableTag?.trim();
  if (params.channel === "stable") {
    return !tag || tag === "latest";
  }
  if (params.channel === "beta") {
    return tag === "beta" || tag === "latest";
  }
  return tag === params.channel;
}

function resolvePersistedUpdateAvailable(
  state: UpdateCheckState,
  channel: UpdateChannel,
): UpdateAvailable | null {
  const latestVersion = state.lastAvailableVersion?.trim();
  if (!latestVersion || !isPersistedAvailabilityForChannel({ state, channel })) {
    return null;
  }
  const cmp = compareSemverStrings(VERSION, latestVersion);
  if (cmp == null || cmp >= 0) {
    return null;
  }
  const persistedTag = state.lastAvailableTag?.trim() || channelToNpmTag(channel);
  return {
    currentVersion: VERSION,
    latestVersion,
    channel: persistedTag,
  };
}

function clearAvailabilityState(nextState: UpdateCheckState): void {
  delete nextState.lastAvailableVersion;
  delete nextState.lastAvailableTag;
}

function resolveStableJitterMs(params: {
  installId: string;
  version: string;
  tag: string;
  jitterWindowMs: number;
}): number {
  if (params.jitterWindowMs <= 0) {
    return 0;
  }
  const hash = createHash("sha256")
    .update(`${params.installId}:${params.version}:${params.tag}`)
    .digest();
  const bucket = hash.readUInt32BE(0);
  return bucket % (Math.floor(params.jitterWindowMs) + 1);
}

function resolveUpdateCheckNowMs(valueMs: unknown): number {
  return asDateTimestampMs(valueMs) ?? asDateTimestampMs(Date.now()) ?? 0;
}

function resolveUpdateCheckTimestamp(valueMs: unknown): string {
  return (
    timestampMsToIsoString(valueMs) ??
    timestampMsToIsoString(resolveUpdateCheckNowMs(Date.now())) ??
    new Date().toISOString()
  );
}

function resolveStableAutoApplyAtMs(params: {
  state: UpdateCheckState;
  nextState: UpdateCheckState;
  nowMs: number;
  version: string;
  tag: string;
  stableDelayHours: number;
  stableJitterHours: number;
}): number {
  if (!params.nextState.autoInstallId) {
    params.nextState.autoInstallId = params.state.autoInstallId?.trim() || randomUUID();
  }
  const installId = params.nextState.autoInstallId;
  const matchesExisting =
    params.state.autoFirstSeenVersion === params.version &&
    params.state.autoFirstSeenTag === params.tag;

  if (!matchesExisting) {
    params.nextState.autoFirstSeenVersion = params.version;
    params.nextState.autoFirstSeenTag = params.tag;
    params.nextState.autoFirstSeenAt = resolveUpdateCheckTimestamp(params.nowMs);
  } else {
    params.nextState.autoFirstSeenVersion = params.state.autoFirstSeenVersion;
    params.nextState.autoFirstSeenTag = params.state.autoFirstSeenTag;
    params.nextState.autoFirstSeenAt = params.state.autoFirstSeenAt;
  }

  const parsedFirstSeenMs = params.nextState.autoFirstSeenAt
    ? Date.parse(params.nextState.autoFirstSeenAt)
    : params.nowMs;
  const firstSeenMs = Number.isFinite(parsedFirstSeenMs) ? parsedFirstSeenMs : params.nowMs;
  const baseDelayMs = Math.max(0, params.stableDelayHours) * ONE_HOUR_MS;
  const jitterWindowMs = Math.max(0, params.stableJitterHours) * ONE_HOUR_MS;
  const jitterMs = resolveStableJitterMs({
    installId,
    version: params.version,
    tag: params.tag,
    jitterWindowMs,
  });

  return firstSeenMs + baseDelayMs + jitterMs;
}

async function runAutoUpdateCommand(
  params: AutoUpdateRunParams,
  log: { info: (msg: string, meta?: Record<string, unknown>) => void },
): Promise<AutoUpdateRunResult> {
  const startedAt = Date.now();
  const command = formatManagedServiceUpdateCommand({
    channel: params.channel,
    ...(params.packageTargetVersion ? { tag: params.packageTargetVersion } : {}),
    timeoutMs: params.timeoutMs,
  });
  const failure = (
    reason: string,
    message: string,
    status: "error" | "skipped" = "error",
  ): AutoUpdateRunResult => ({
    status: "failed",
    result: {
      status,
      mode: params.mode,
      root: params.root,
      reason,
      before: { version: VERSION },
      steps: [],
      durationMs: Date.now() - startedAt,
    },
    message,
  });
  if (isGatewayExternallySupervised()) {
    return failure(
      EXTERNAL_SUPERVISOR_UPDATE_REQUIRED_REASON,
      "Use the external supervisor's update workflow to stop, update, and restart the Gateway.",
      "skipped",
    );
  }
  const supervisor = detectRespawnSupervisor(process.env, process.platform, {
    includeLinuxOpenClawGatewayServiceMarker: true,
  });
  if (!supervisor) {
    return failure(
      "managed-service-handoff-unavailable",
      buildManagedServiceHandoffUnavailableMessage(command),
      "skipped",
    );
  }

  try {
    params.signal?.throwIfAborted();
    if (params.devTarget) {
      const result = await runGatewayUpdatePreflight(
        params.root,
        params.timeoutMs,
        params.devTarget,
        params.signal,
      );
      params.signal?.throwIfAborted();
      if (result) {
        return {
          status: "failed",
          result,
          message: `Automatic update preflight failed. Run \`${command}\` from a shell to inspect and retry.`,
        };
      }
    }
    if (!params.root?.trim()) {
      throw new Error("managed auto-update install root is unavailable");
    }
    const restartDelayMs = normalizeGatewayRestartDelayMs(supervisor === "systemd" ? undefined : 0);
    const handoffId = randomUUID();
    const started = await startManagedServiceUpdateHandoff({
      root: params.root,
      timeoutMs: params.timeoutMs,
      restartDrainTimeoutMs:
        resolveGatewayRestartDeferralTimeoutMs(params.restartDrainTimeoutMs) ??
        resolveGatewayRestartDeferralTimeoutMs(),
      channel: params.channel,
      ...(params.packageTargetVersion ? { tag: params.packageTargetVersion } : {}),
      restartDelayMs,
      supervisor,
      handoffId,
      ...(params.devTarget ? { devTarget: params.devTarget } : {}),
      meta: { handoffId, note: "background auto-update" },
    });
    if (started.status === "started") {
      const successorOwner = {
        kind: "managed-update-handoff" as const,
        handoffId: started.handoffId,
        installRoot: started.installRoot,
      };
      if (params.signal?.aborted) {
        const cancelled = await cancelManagedServiceUpdateHandoff(successorOwner);
        if (cancelled !== "restored-in-process") {
          log.info("stopped auto-update handoff cancellation could not be verified", {
            result: cancelled,
            command: started.command,
            logPath: started.logPath,
          });
        }
        params.signal.throwIfAborted();
      }
      // Pair owned helper creation with restart scheduling before persistence;
      // a joined helper belongs to its original caller, including cancellation.
      scheduleGatewaySigusr1Restart({
        delayMs: restartDelayMs,
        reason: "update.auto",
        successorOwner,
        skipCooldown: true,
        skipDeferral: true,
      });
    }
    return {
      status: "handoff",
      command: started.command,
      logPath: started.logPath,
    };
  } catch (err) {
    // Filesystem failures can contain private helper paths; keep the full cause local.
    log.info("automatic update handoff failed", { error: String(err) });
    const code = extractErrorCode(err);
    return failure(
      "managed-service-handoff-failed",
      `Automatic update handoff failed${code ? ` (${code})` : ""}. Inspect the Gateway log, then run \`${command}\` from a shell to retry.`,
    );
  }
}

function clearAutoState(nextState: UpdateCheckState): void {
  delete nextState.autoFirstSeenVersion;
  delete nextState.autoFirstSeenTag;
  delete nextState.autoFirstSeenAt;
}

async function resolveStartupInstallStatus(fetchRemoteGit: boolean, signal: AbortSignal) {
  const [root, installReceipt] = await Promise.all([
    resolveOpenClawPackageRoot({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    }),
    readVerifiedGitUpdateReceipt(),
  ]);
  const gitUpstreamFallback =
    installReceipt?.upstreamRef && root && updateInstallRootsMatch(root, installReceipt.root)
      ? { currentSha: installReceipt.sha, upstreamRef: installReceipt.upstreamRef }
      : undefined;
  const status = await checkUpdateStatus({
    root,
    signal,
    ...(fetchRemoteGit ? {} : { timeoutMs: 2500 }),
    fetchGit: fetchRemoteGit,
    includeRegistry: false,
    ...(fetchRemoteGit ? { useDetachedDevUpstream: true } : {}),
    ...(gitUpstreamFallback ? { gitUpstreamFallback } : {}),
  });
  signal.throwIfAborted();
  return { root, status, installReceipt };
}

/** Caches only the fast local install probe; remote Git refresh remains post-ready. */
export function initializeGatewayUpdateStatus(): ReturnType<typeof resolveStartupInstallStatus> {
  return currentUpdateCheckLifecycle().initialize();
}

type GitScheduleStatus = NonNullable<NonNullable<UpdateScheduleState["install"]>["git"]>;

function resolveGitInstalledAtMs(
  git: NonNullable<UpdateCheckResult["git"]>,
  installReceipt: VerifiedGitUpdateReceipt | null,
  root: string | null,
): number | undefined {
  return installReceipt &&
    root !== null &&
    updateInstallRootsMatch(root, installReceipt.root) &&
    git.sha &&
    gitCommitPrefixesMatch(installReceipt.sha, git.sha)
    ? installReceipt.installedAtMs
    : undefined;
}

function resolveGitScheduleStatus(
  update: UpdateCheckResult,
  installReceipt: VerifiedGitUpdateReceipt | null,
  root: string | null,
): GitScheduleStatus | undefined {
  if (update.installKind !== "git") {
    return undefined;
  }
  const git = update.git;
  const installedAtMs = git ? resolveGitInstalledAtMs(git, installReceipt, root) : undefined;
  const metadata = git
    ? {
        ...(git.sha ? { currentSha: git.sha } : {}),
        ...(typeof git.commitAtMs === "number" ? { commitAtMs: git.commitAtMs } : {}),
        ...(installedAtMs === undefined ? {} : { installedAtMs }),
      }
    : {};
  if (!git || git.error || !git.sha) {
    return { ...metadata, status: "unavailable", reason: "git-unavailable" };
  }
  if (git.fetchOk !== true) {
    return { ...metadata, status: "unavailable", reason: "fetch-failed" };
  }
  if (!git.upstream) {
    return { ...metadata, status: "unavailable", reason: "no-upstream" };
  }
  if (!git.upstreamSha) {
    return { ...metadata, status: "unavailable", reason: "no-upstream-sha" };
  }
  if (git.ahead === null || git.behind === null) {
    return { ...metadata, status: "unavailable", reason: "comparison-failed" };
  }
  if (git.ahead > 0 && git.behind > 0) {
    return {
      ...metadata,
      status: "diverged",
      commitsAhead: git.ahead,
      commitsBehind: git.behind,
    };
  }
  if (git.behind > 0) {
    return { ...metadata, status: "behind", commitsBehind: git.behind };
  }
  if (git.ahead > 0) {
    return { ...metadata, status: "ahead", commitsAhead: git.ahead };
  }
  return { ...metadata, status: "current" };
}

function withInstallStatus(
  schedule: UpdateScheduleState,
  update: UpdateCheckResult,
  includeGitStatus: boolean,
  installReceipt: VerifiedGitUpdateReceipt | null,
  root: string | null,
): UpdateScheduleState {
  const git = includeGitStatus ? resolveGitScheduleStatus(update, installReceipt, root) : undefined;
  return {
    ...schedule,
    install: {
      kind: update.installKind,
      ...(git ? { git } : {}),
    },
  };
}

/** Refreshes the read-only Dev checkout comparison used by update.status. */
export function refreshGatewayUpdateStatus(cfg: OpenClawConfig): Promise<void> {
  const lifecycle = currentUpdateCheckLifecycle();
  const pending = lifecycle.refreshes.get(cfg);
  if (pending) {
    return pending;
  }
  const refresh = lifecycle
    .run(async (signal) => {
      const scheduleAtStart = updateScheduleCache;
      const configured = normalizeUpdateChannel(cfg.update?.channel);
      const channel =
        configured ??
        resolveEffectiveUpdateChannel({
          currentVersion: VERSION,
          ...(await lifecycle.initialize()).status,
        }).channel;
      const isCurrent = () =>
        lifecycle === updateCheckLifecycle &&
        !signal.aborted &&
        (updateScheduleCache === scheduleAtStart || updateScheduleCache?.channel === channel);
      if (channel !== "dev" || !isCurrent()) {
        return;
      }
      const { root, status, installReceipt } = await resolveStartupInstallStatus(true, signal);
      if (!isCurrent()) {
        return;
      }
      const current =
        updateScheduleCache?.channel === channel
          ? updateScheduleCache
          : { channel, autoEnabled: Boolean(cfg.update?.auto?.enabled) };
      setUpdateScheduleCache({
        next: withInstallStatus(current, status, true, installReceipt, root),
      });
    })
    .finally(() => {
      if (lifecycle.refreshes.get(cfg) === refresh) {
        lifecycle.refreshes.delete(cfg);
      }
    });
  lifecycle.refreshes.set(cfg, refresh);
  return refresh;
}

async function resolveDevGitCommits(params: {
  root: string;
  currentSha: string;
  upstreamSha: string;
  signal: AbortSignal;
}): Promise<Array<{ sha: string; subject: string }>> {
  const result = await executeGitCommand(
    params.root,
    [
      "log",
      "--format=%h%x09%s",
      `--max-count=${DEV_COMMIT_LIMIT}`,
      `${params.currentSha}..${params.upstreamSha}`,
    ],
    {
      timeoutMs: 2500,
      signal: params.signal,
      killProcessTree: true,
      maxOutputBytes: { stdout: DEV_COMMIT_LOG_MAX_OUTPUT_BYTES, stderr: 1024 },
    },
  ).catch(() => null);
  if (!result || result.code !== 0 || result.termination !== "exit") {
    return [];
  }
  return result.stdout
    .split("\n")
    .flatMap((line) => {
      const separator = line.indexOf("\t");
      const sha = separator < 0 ? "" : line.slice(0, separator).trim();
      if (!sha) {
        return [];
      }
      return [
        {
          sha,
          subject: line
            .slice(separator + 1)
            .trim()
            .slice(0, DEV_COMMIT_SUBJECT_MAX_LENGTH),
        },
      ];
    })
    .slice(0, DEV_COMMIT_LIMIT);
}

// The owner joins preflight and handoff readiness, never the detached helper's
// subsequent wait for Gateway exit.
async function runCampaignUpdate(params: {
  channel: "stable" | "beta" | "dev";
  mode: UpdateRunResult["mode"];
  version: string;
  tag: string;
  forced: boolean;
  root?: string;
  devTarget?: TrackedDevUpdateTarget;
  log: { info: (msg: string, meta?: Record<string, unknown>) => void };
  runAuto: AutoUpdateRunner;
  campaign: UpdateCampaignController;
  signal?: AbortSignal;
}): Promise<"handoff" | "failed"> {
  const campaignId = params.campaign.getState()?.id;
  const isCurrent = () =>
    campaignId !== undefined &&
    !params.signal?.aborted &&
    params.campaign.getState()?.id === campaignId;
  if (!isCurrent()) {
    return "failed";
  }
  // Capture recovery code before the updater can replace the running installation.
  const { runUpdateFailureTriage } = await import("./update-triage.js");
  const { sentinel, revision } = await readRestartSentinelSnapshot();
  if (!isCurrent()) {
    return "failed";
  }
  const attemptAt = resolveUpdateCheckNowMs(Date.now());
  const attemptState = readState();
  attemptState.autoLastAttemptVersion = params.version;
  attemptState.autoLastAttemptAt = resolveUpdateCheckTimestamp(attemptAt);
  writeState(attemptState);

  const outcome = await params.runAuto({
    channel: params.channel,
    mode: params.mode,
    timeoutMs: AUTO_UPDATE_COMMAND_TIMEOUT_MS,
    restartDrainTimeoutMs: resolveGatewayRestartDeferralTimeoutMs(),
    ...(params.root ? { root: params.root } : {}),
    ...(params.channel === "dev" ? {} : { packageTargetVersion: params.version }),
    ...(params.devTarget ? { devTarget: params.devTarget } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (!isCurrent()) {
    return "failed";
  }
  if (outcome.status === "handoff") {
    params.log.info("auto-update handoff started", {
      channel: params.channel,
      version: params.version,
      tag: params.tag,
      forced: params.forced,
      ...(outcome.command ? { command: outcome.command } : {}),
      ...(outcome.logPath ? { logPath: outcome.logPath } : {}),
    });
    return "handoff";
  }
  let triageHint: string | undefined;
  if (classifyUpdateOutcome(outcome.result) === "failed") {
    const triage = await runUpdateFailureTriage({
      failure: { result: outcome.result, error: outcome.message },
      target: { root: params.root, env: process.env },
      mode: "json",
      runtime: {
        log: (message) => params.log.info(message),
        error: (message) => params.log.info(message),
      },
      signal: params.signal,
      isCurrent,
    });
    if (triage.status !== "cancelled") {
      triageHint = triage.hint;
    }
  }
  if (!isCurrent()) {
    return "failed";
  }
  // Publish before campaign-ended observers refresh status. A concurrent restart
  // or update keeps its notification; this attempt may replace only its snapshot.
  if (!sentinel || !isPendingControlPlaneUpdateRestartSentinel(sentinel.payload)) {
    await writeRestartSentinelIfUnchanged({
      payload: {
        ...buildUpdateRestartSentinelPayload({
          result: outcome.result,
          meta: { root: params.root, note: outcome.message },
        }),
        ...(triageHint ? { doctorHint: triageHint } : {}),
      },
      expectedRevision: revision,
      isCurrent,
    });
  }
  params.log.info("auto-update attempt failed", {
    channel: params.channel,
    version: params.version,
    tag: params.tag,
    forced: params.forced,
    reason: outcome.result.reason,
    message: outcome.message,
    ...(triageHint ? { triage: triageHint } : {}),
  });
  return "failed";
}

export async function runGatewayUpdateCheck(
  params: {
    cfg: OpenClawConfig;
    log: { info: (msg: string, meta?: Record<string, unknown>) => void };
    isNixMode: boolean;
    allowInTests?: boolean;
    onUpdateAvailableChange?: (updateAvailable: UpdateAvailable | null) => void;
    onUpdateScheduleChange?: (schedule: UpdateScheduleState) => void;
    activeWorkInspectors?: Partial<GatewayActiveWorkInspectors>;
    updateCampaign?: UpdateCampaignController;
    runAutoUpdate?: AutoUpdateRunner;
    signal?: AbortSignal;
  },
  lifecycle = currentUpdateCheckLifecycle(),
): Promise<void> {
  return lifecycle.run((signal) =>
    runGatewayUpdateCheckOwned(
      { ...params, signal: params.signal ? AbortSignal.any([signal, params.signal]) : signal },
      lifecycle,
    ),
  );
}

async function runGatewayUpdateCheckOwned(
  params: Parameters<typeof runGatewayUpdateCheck>[0] & { signal: AbortSignal },
  lifecycle: UpdateCheckLifecycle,
): Promise<void> {
  params.signal?.throwIfAborted();
  if (shouldSkipCheck(Boolean(params.allowInTests))) {
    return;
  }
  if (params.isNixMode) {
    return;
  }
  const configChannel = normalizeUpdateChannel(params.cfg.update?.channel);
  const updateCampaign = params.updateCampaign ?? gatewayUpdateCampaign;
  const runAuto: AutoUpdateRunner =
    params.runAutoUpdate ?? ((runParams) => runAutoUpdateCommand(runParams, params.log));
  const auto = resolveAutoUpdatePolicy(params.cfg);
  const autoDisabledByEnv = isTruthyEnvValue(process.env.OPENCLAW_NO_AUTO_UPDATE);
  if (params.cfg.update?.checkOnStart === false || autoDisabledByEnv) {
    updateCampaign.clear();
    setUpdateAvailableCache({
      next: null,
      onUpdateAvailableChange: params.onUpdateAvailableChange,
    });
    const channel = configChannel ?? updateScheduleCache?.channel ?? DEFAULT_PACKAGE_CHANNEL;
    const currentSchedule =
      updateScheduleCache?.channel === channel
        ? updateScheduleCache
        : { channel, autoEnabled: false };
    setUpdateScheduleCache({
      next: withoutTarget({ ...currentSchedule, autoEnabled: false }),
      onUpdateScheduleChange: params.onUpdateScheduleChange,
    });
    return;
  }
  const autoDisabledByExternalSupervisor = isGatewayExternallySupervised();
  const initializedInstallStatus = await lifecycle.initialize();
  params.signal?.throwIfAborted();
  const potentialChannel = resolveEffectiveUpdateChannel({
    configChannel,
    currentVersion: VERSION,
    installKind: initializedInstallStatus.status.installKind,
    git: initializedInstallStatus.status.git,
  }).channel;
  let installStatus = initializedInstallStatus;
  if (potentialChannel === "dev" && installStatus.status.installKind === "git") {
    installStatus = await resolveStartupInstallStatus(true, params.signal);
    params.signal?.throwIfAborted();
  }
  const configuredChannel = resolveEffectiveUpdateChannel({
    configChannel,
    currentVersion: VERSION,
    installKind: installStatus.status.installKind,
    git: installStatus.status.git,
  }).channel;
  const autoDesired =
    (configuredChannel === "stable" ||
      configuredChannel === "beta" ||
      configuredChannel === "dev") &&
    auto.enabled &&
    !autoDisabledByExternalSupervisor;

  // The admitted target belongs to the applying owner until it settles.
  if (updateCampaign.getState()?.state === "applying") {
    return;
  }
  const channelChanged =
    updateScheduleCache !== null && updateScheduleCache.channel !== configuredChannel;
  if (channelChanged) {
    updateCampaign.clear();
  }
  const priorSchedule =
    updateScheduleCache?.channel === configuredChannel ? updateScheduleCache : null;
  const initialSchedule: UpdateScheduleState = priorSchedule
    ? { ...priorSchedule, autoEnabled: auto.enabled }
    : { channel: configuredChannel, autoEnabled: auto.enabled };
  setUpdateScheduleCache({
    next: autoDesired ? initialSchedule : withoutCampaign(initialSchedule),
    onUpdateScheduleChange: params.onUpdateScheduleChange,
  });
  if (!autoDesired) {
    updateCampaign.clear();
  }
  const onCampaignChange = (campaign: UpdateScheduleState["campaign"] | undefined) => {
    const current = updateScheduleCache;
    if (!current || current.channel !== configuredChannel) {
      return;
    }
    const target =
      current.target?.kind === "package"
        ? current.target.version
        : current.target?.kind === "git"
          ? {
              upstreamSha: current.target.upstreamSha,
              commitsBehind: current.target.commitsBehind,
            }
          : undefined;
    if (campaign) {
      params.log.info(`update campaign ${campaign.state}`, {
        campaignId: campaign.id,
        state: campaign.state,
        channel: configuredChannel,
        ...(target === undefined ? {} : { target }),
        ...(campaign.applyAtMs === undefined ? {} : { applyAtMs: campaign.applyAtMs }),
        ...(campaign.holdUntilMs === undefined ? {} : { holdUntilMs: campaign.holdUntilMs }),
        forceAtMs: campaign.forceAtMs,
      });
    } else {
      params.log.info("update campaign ended", {
        ...(current.campaign?.id ? { campaignId: current.campaign.id } : {}),
        channel: configuredChannel,
        ...(target === undefined ? {} : { target }),
      });
    }
    setUpdateScheduleCache({
      next: campaign ? { ...current, campaign } : withoutCampaign(current),
      onUpdateScheduleChange: params.onUpdateScheduleChange,
    });
  };

  if (configuredChannel === "extended-stable" || configuredChannel === "dev") {
    setUpdateScheduleCache({
      next: withInstallStatus(
        updateScheduleCache ?? initialSchedule,
        installStatus.status,
        configuredChannel === "dev",
        installStatus.installReceipt,
        installStatus.root,
      ),
      onUpdateScheduleChange: params.onUpdateScheduleChange,
    });
  }
  if (configuredChannel === "extended-stable") {
    if (installStatus.status.installKind !== "package") {
      updateCampaign.clear();
      setUpdateAvailableCache({
        next: null,
        onUpdateAvailableChange: params.onUpdateAvailableChange,
      });
      setUpdateScheduleCache({
        next: withoutTarget(updateScheduleCache ?? initialSchedule),
        onUpdateScheduleChange: params.onUpdateScheduleChange,
      });
      return;
    }
  }

  const isDevGit = configuredChannel === "dev" && installStatus?.status.installKind === "git";
  const shouldRunAutoUpdate =
    autoDesired && (configuredChannel === "stable" || configuredChannel === "beta" || isDevGit);
  if (!shouldRunAutoUpdate) {
    updateCampaign.clear();
  }
  const telemetryUpdate = await checkTelemetryUpdate(params.cfg, { surface: "gateway" });
  params.signal?.throwIfAborted();
  const state = readState();
  const rawNow = Date.now();
  const now = resolveUpdateCheckNowMs(rawNow);
  const rawNowIsValid = asDateTimestampMs(rawNow) !== undefined;
  const lastCheckedAt = state.lastCheckedAt ? Date.parse(state.lastCheckedAt) : null;
  const persistedAvailable = isDevGit
    ? null
    : resolvePersistedUpdateAvailable(state, configuredChannel);
  const cacheMatchesChannel = state.lastCheckedChannel === configuredChannel;
  const shouldBypassSharedThrottle = isDevGit || !cacheMatchesChannel;
  setUpdateAvailableCache({
    next: persistedAvailable,
    onUpdateAvailableChange: params.onUpdateAvailableChange,
  });
  if (persistedAvailable) {
    setUpdateScheduleCache({
      next: {
        ...(updateScheduleCache ?? initialSchedule),
        target: { kind: "package", version: persistedAvailable.latestVersion },
      },
      onUpdateScheduleChange: params.onUpdateScheduleChange,
    });
  }
  const checkIntervalMs = shouldRunAutoUpdate
    ? resolveCheckIntervalMs(params.cfg, installStatus?.status.installKind)
    : UPDATE_CHECK_INTERVAL_MS;
  if (
    !shouldBypassSharedThrottle &&
    rawNowIsValid &&
    lastCheckedAt &&
    Number.isFinite(lastCheckedAt)
  ) {
    if (now - lastCheckedAt < checkIntervalMs) {
      return;
    }
  }

  const { root, status, installReceipt } = installStatus;
  setUpdateScheduleCache({
    next: withInstallStatus(
      updateScheduleCache ?? initialSchedule,
      status,
      isDevGit,
      installReceipt,
      root,
    ),
    onUpdateScheduleChange: params.onUpdateScheduleChange,
  });

  const nextState: UpdateCheckState = {
    ...state,
    lastCheckedAt: resolveUpdateCheckTimestamp(now),
    lastCheckedChannel: configuredChannel,
  };
  if (!cacheMatchesChannel) {
    clearAvailabilityState(nextState);
  }

  if (isDevGit) {
    clearAvailabilityState(nextState);
    clearAutoState(nextState);
    const git = status.git;
    if (
      typeof git?.behind !== "number" ||
      git.behind <= 0 ||
      !git.sha ||
      !git.upstream ||
      !git.upstreamSha
    ) {
      updateCampaign.clear();
      setUpdateAvailableCache({
        next: null,
        onUpdateAvailableChange: params.onUpdateAvailableChange,
      });
      setUpdateScheduleCache({
        next: withoutTarget(updateScheduleCache ?? initialSchedule),
        onUpdateScheduleChange: params.onUpdateScheduleChange,
      });
      writeState(nextState);
      return;
    }
    const currentSha = git.sha;
    const upstreamRef = git.upstream;
    const upstreamSha = git.upstreamSha;
    const commitsBehind = git.behind;
    const commits = await resolveDevGitCommits({
      root: git.root,
      currentSha,
      upstreamSha,
      signal: params.signal,
    });
    params.signal?.throwIfAborted();

    const target: NonNullable<UpdateScheduleState["target"]> = {
      kind: "git",
      upstreamRef,
      upstreamSha,
      commitsBehind,
    };
    if (!updateCampaign.reconcileTarget(target)) {
      return;
    }
    const nextAvailable: UpdateAvailable = {
      currentVersion: VERSION,
      latestVersion: VERSION,
      channel: "dev",
      currentSha,
      upstreamRef,
      upstreamSha,
      commitsBehind,
      commits,
    };
    setUpdateAvailableCache({
      next: nextAvailable,
      onUpdateAvailableChange: params.onUpdateAvailableChange,
    });
    setUpdateScheduleCache({
      next: { ...(updateScheduleCache ?? initialSchedule), target },
      onUpdateScheduleChange: params.onUpdateScheduleChange,
    });

    if (auto.enabled && autoDisabledByExternalSupervisor) {
      params.log.info("auto-update delegated to external supervisor", {
        version: upstreamSha,
        tag: "dev",
        reason: EXTERNAL_SUPERVISOR_UPDATE_REQUIRED_REASON,
      });
    }
    const hasTrackedDevUpstream =
      (git.branch === DEV_BRANCH || git.branch === "HEAD") && git.upstreamSource === "tracking";
    const hasReceiptBackedDetachedHead = git.branch === "HEAD" && git.upstreamSource === "receipt";
    const canRunTrackedDevCampaign =
      (hasTrackedDevUpstream || hasReceiptBackedDetachedHead) && git.ahead === 0;
    if (shouldRunAutoUpdate && canRunTrackedDevCampaign) {
      const lastAttemptAt = state.autoLastAttemptAt ? Date.parse(state.autoLastAttemptAt) : null;
      const recentAttempt =
        lastAttemptAt != null &&
        Number.isFinite(lastAttemptAt) &&
        now - lastAttemptAt < ONE_HOUR_MS;
      if (!recentAttempt) {
        updateCampaign.announce({
          target,
          inspect: params.activeWorkInspectors,
          onChange: onCampaignChange,
          apply: ({ forced }) =>
            lifecycle.run(() =>
              runCampaignUpdate({
                channel: "dev",
                mode: "git",
                version: upstreamSha,
                tag: "dev",
                forced,
                root: root ?? status.root ?? undefined,
                devTarget: devUpdateTargetFromGitTarget(target),
                log: params.log,
                runAuto,
                campaign: updateCampaign,
                signal: params.signal,
              }),
            ),
        });
      }
    } else {
      updateCampaign.clear();
    }
    writeState(nextState);
    return;
  }

  if (status.installKind !== "package") {
    clearAvailabilityState(nextState);
    clearAutoState(nextState);
    setUpdateAvailableCache({
      next: null,
      onUpdateAvailableChange: params.onUpdateAvailableChange,
    });
    updateCampaign.clear();
    setUpdateScheduleCache({
      next: withoutTarget(updateScheduleCache ?? initialSchedule),
      onUpdateScheduleChange: params.onUpdateScheduleChange,
    });
    writeState(nextState);
    return;
  }

  const channel = configuredChannel;
  const resolved =
    shouldRunAutoUpdate || channel !== "stable"
      ? await resolveNpmChannelTag({ channel, timeoutMs: 2500 })
      : {
          tag: "latest",
          version: telemetryUpdate?.version ?? null,
        };
  params.signal?.throwIfAborted();
  const tag = resolved.tag;
  if (!resolved.version) {
    if (channel === "extended-stable") {
      clearAvailabilityState(nextState);
      setUpdateAvailableCache({
        next: null,
        onUpdateAvailableChange: params.onUpdateAvailableChange,
      });
      updateCampaign.clear();
      setUpdateScheduleCache({
        next: withoutTarget(updateScheduleCache ?? initialSchedule),
        onUpdateScheduleChange: params.onUpdateScheduleChange,
      });
    }
    writeState(nextState);
    return;
  }
  const resolvedVersion = resolved.version;

  const cmp = compareSemverStrings(VERSION, resolvedVersion);
  if (cmp != null && cmp < 0) {
    const nextAvailable: UpdateAvailable = {
      currentVersion: VERSION,
      latestVersion: resolved.version,
      channel: tag,
    };
    const target: NonNullable<UpdateScheduleState["target"]> = {
      kind: "package",
      version: resolved.version,
    };
    if (!updateCampaign.reconcileTarget(target)) {
      return;
    }
    setUpdateScheduleCache({
      next: { ...(updateScheduleCache ?? initialSchedule), target },
      onUpdateScheduleChange: params.onUpdateScheduleChange,
    });
    setUpdateAvailableCache({
      next: nextAvailable,
      onUpdateAvailableChange: params.onUpdateAvailableChange,
    });
    nextState.lastAvailableVersion = resolved.version;
    nextState.lastAvailableTag = tag;
    const shouldNotify =
      state.lastNotifiedVersion !== resolved.version || state.lastNotifiedTag !== tag;
    if (shouldNotify) {
      const updateNotice = `update available (${tag}): v${resolved.version} (current v${VERSION}). Run: ${formatCliCommand("openclaw update")}`;
      const note = telemetryUpdate?.note
        ? sanitizeTerminalText(telemetryUpdate.note).trim().slice(0, 500)
        : undefined;
      params.log.info(note ? `${updateNotice} Note: ${note}` : updateNotice);
      nextState.lastNotifiedVersion = resolved.version;
      nextState.lastNotifiedTag = tag;
    }

    if (channel !== "extended-stable" && auto.enabled && autoDisabledByExternalSupervisor) {
      params.log.info("auto-update delegated to external supervisor", {
        version: resolved.version,
        tag,
        reason: EXTERNAL_SUPERVISOR_UPDATE_REQUIRED_REASON,
      });
    }

    if (shouldRunAutoUpdate && (channel === "stable" || channel === "beta")) {
      const attemptIntervalMs =
        channel === "beta"
          ? Math.max(ONE_HOUR_MS / 4, Math.floor(auto.betaCheckIntervalHours * ONE_HOUR_MS))
          : ONE_HOUR_MS;
      const lastAttemptAt = state.autoLastAttemptAt ? Date.parse(state.autoLastAttemptAt) : null;
      const recentAttemptForSameVersion =
        state.autoLastAttemptVersion === resolved.version &&
        lastAttemptAt != null &&
        Number.isFinite(lastAttemptAt) &&
        now - lastAttemptAt < attemptIntervalMs;

      let dueNow = channel === "beta";
      let applyAfterMs: number | null = null;
      if (channel === "stable") {
        applyAfterMs = resolveStableAutoApplyAtMs({
          state,
          nextState,
          nowMs: now,
          version: resolved.version,
          tag,
          stableDelayHours: auto.stableDelayHours,
          stableJitterHours: auto.stableJitterHours,
        });
        dueNow = now >= applyAfterMs;
      }

      if (!dueNow) {
        params.log.info("auto-update deferred (stable rollout window active)", {
          version: resolved.version,
          tag,
          applyAfter: applyAfterMs ? resolveUpdateCheckTimestamp(applyAfterMs) : undefined,
        });
      } else if (recentAttemptForSameVersion) {
        params.log.info("auto-update deferred (recent attempt exists)", {
          version: resolved.version,
          tag,
        });
      } else {
        updateCampaign.announce({
          target,
          inspect: params.activeWorkInspectors,
          onChange: onCampaignChange,
          apply: ({ forced }) =>
            lifecycle.run(() =>
              runCampaignUpdate({
                channel,
                mode: status.packageManager,
                version: resolvedVersion,
                tag,
                forced,
                root: root ?? status.root ?? undefined,
                log: params.log,
                runAuto,
                campaign: updateCampaign,
                signal: params.signal,
              }),
            ),
        });
      }
    }
  } else {
    if (channel === "extended-stable") {
      clearAvailabilityState(nextState);
    } else {
      clearAvailabilityState(nextState);
      clearAutoState(nextState);
    }
    setUpdateAvailableCache({
      next: null,
      onUpdateAvailableChange: params.onUpdateAvailableChange,
    });
    updateCampaign.clear();
    setUpdateScheduleCache({
      next: withoutTarget(updateScheduleCache ?? initialSchedule),
      onUpdateScheduleChange: params.onUpdateScheduleChange,
    });
  }

  writeState(nextState);
}

export function createGatewayUpdateCheck(params: {
  cfg: OpenClawConfig;
  log: { info: (msg: string, meta?: Record<string, unknown>) => void };
  isNixMode: boolean;
  onUpdateAvailableChange?: (updateAvailable: UpdateAvailable | null) => void;
  onUpdateScheduleChange?: (schedule: UpdateScheduleState) => void;
  activeWorkInspectors?: Partial<GatewayActiveWorkInspectors>;
}): {
  initialize: () => ReturnType<typeof resolveStartupInstallStatus>;
  start: () => void;
  stop: () => Promise<void>;
} {
  const lifecycle = createUpdateCheckLifecycle();
  updateCheckLifecycle = lifecycle;
  let started = false;
  return {
    initialize: lifecycle.initialize,
    stop: lifecycle.stop,
    start: () => {
      if (started || lifecycle.signal.aborted) {
        return;
      }
      started = true;
      lifecycle.schedule(async () => {
        try {
          await runGatewayUpdateCheck(params, lifecycle);
        } catch {
          // Discovery failures must not crash or retire the Gateway update loop.
        }
        return resolveCheckIntervalMs(params.cfg, updateScheduleCache?.install?.kind);
      });
      lifecycle.schedule(async () => {
        try {
          const result = await refreshRemoteModelCatalog({
            config: params.cfg,
            signal: lifecycle.signal,
          });
          if (lifecycle.signal.aborted) {
            return REMOTE_MODEL_CATALOG_TTL_MS;
          }
          if (result.status === "error") {
            params.log.info("remote model catalog refresh failed", { error: result.error });
          } else if (result.status === "updated") {
            params.log.info("remote model catalog updated; restart the Gateway to apply it", {
              providers: result.providers,
              models: result.models,
              generatedAt: result.generatedAt,
            });
          }
          return result.status === "fresh" ? result.nextCheckInMs : REMOTE_MODEL_CATALOG_TTL_MS;
        } catch (error) {
          if (!lifecycle.signal.aborted) {
            params.log.info("remote model catalog refresh failed", { error: String(error) });
          }
          return REMOTE_MODEL_CATALOG_TTL_MS;
        }
      }, true);
    },
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
