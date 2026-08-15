// Runs startup update checks and optional auto-update handoff.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  asDateTimestampMs,
  timestampMsToIsoString,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type {
  UpdateAvailable,
  UpdateScheduleState,
} from "../../packages/gateway-protocol/src/index.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  refreshRemoteModelCatalog,
  REMOTE_MODEL_CATALOG_TTL_MS,
} from "../model-catalog/remote-refresh.js";
import { runCommandWithTimeout } from "../process/exec.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { VERSION } from "../version.js";
import { isTruthyEnvValue } from "./env.js";
import type { GatewayActiveWorkInspectors } from "./gateway-active-work.js";
import {
  EXTERNAL_SUPERVISOR_UPDATE_REQUIRED_REASON,
  isGatewayExternallySupervised,
} from "./gateway-supervision.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { resolveOpenClawPackageRoot } from "./openclaw-root.js";
import { readVerifiedGitUpdateReceipt, type VerifiedGitUpdateReceipt } from "./restart-sentinel.js";
import {
  resolveGatewayRestartDeferralTimeoutMs,
  scheduleGatewaySigusr1Restart,
} from "./restart.js";
import { detectRespawnSupervisor, type RespawnSupervisor } from "./supervisor-markers.js";
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
import { CONTROL_PLANE_UPDATE_HANDOFF_STARTED_REASON } from "./update-control-plane-sentinel.js";
import {
  applyDevUpdateTargetEnv,
  devUpdateTargetFromGitCampaign,
  type TrackedDevUpdateTarget,
} from "./update-dev-target.js";
import { updateInstallRootsMatch } from "./update-install-root.js";
import { startManagedServiceUpdateHandoff } from "./update-managed-service-handoff.js";

type UpdateCheckState = {
  lastCheckedAt?: string;
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
  autoLastSuccessVersion?: string;
  autoLastSuccessAt?: string;
};

type AutoUpdatePolicy = {
  enabled: boolean;
  stableDelayHours: number;
  stableJitterHours: number;
  betaCheckIntervalHours: number;
};

type AutoUpdateRunResult = {
  ok: boolean;
  code: number | null;
  stdout?: string;
  stderr?: string;
  reason?: string;
  command?: string;
  logPath?: string;
};

type AutoUpdateRunParams = {
  channel: "stable" | "beta" | "dev";
  timeoutMs: number;
  restartDrainTimeoutMs: number | undefined;
  root?: string;
  packageTargetVersion?: string;
  devTarget?: TrackedDevUpdateTarget;
};

type AutoUpdateRunner = (params: AutoUpdateRunParams) => Promise<AutoUpdateRunResult>;

export type {
  UpdateAvailable,
  UpdateScheduleState,
} from "../../packages/gateway-protocol/src/index.js";

let updateAvailableCache: UpdateAvailable | null = null;
let updateScheduleCache: UpdateScheduleState | null = null;

export function getUpdateAvailable(): UpdateAvailable | null {
  return updateAvailableCache;
}

export function getUpdateSchedule(): UpdateScheduleState | null {
  return updateScheduleCache;
}

export function resetUpdateAvailableStateForTest(): void {
  updateAvailableCache = null;
  updateScheduleCache = null;
  gatewayUpdateCampaign.resetForTest();
}

const UPDATE_CHECK_STATE_KEY = "default";
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const AUTO_UPDATE_COMMAND_TIMEOUT_MS = 45 * 60 * 1000;
const AUTO_STABLE_DELAY_HOURS_DEFAULT = 6;
const AUTO_STABLE_JITTER_HOURS_DEFAULT = 12;
const AUTO_BETA_CHECK_INTERVAL_HOURS_DEFAULT = 1;
const MANAGED_AUTO_UPDATE_SYSTEMD_RESTART_GRACE_MS = 2000;
const DEV_COMMIT_LIMIT = 5;
const DEV_COMMIT_SUBJECT_MAX_LENGTH = 120;
const DEV_COMMIT_LOG_MAX_OUTPUT_BYTES = 8 * 1024;

type UpdateCheckStateDatabase = Pick<OpenClawStateKyselyDatabase, "update_check_state">;

function shouldSkipCheck(allowInTests: boolean): boolean {
  if (allowInTests) {
    return false;
  }
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return true;
  }
  return false;
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

function presentString(value: string | null): string | undefined {
  return value ?? undefined;
}

async function readState(): Promise<UpdateCheckState> {
  const database = openOpenClawStateDatabase();
  const stateDb = getNodeSqliteKysely<UpdateCheckStateDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    stateDb
      .selectFrom("update_check_state")
      .selectAll()
      .where("state_key", "=", UPDATE_CHECK_STATE_KEY),
  );
  if (!row) {
    return {};
  }
  return {
    lastCheckedAt: presentString(row.last_checked_at),
    lastNotifiedVersion: presentString(row.last_notified_version),
    lastNotifiedTag: presentString(row.last_notified_tag),
    lastAvailableVersion: presentString(row.last_available_version),
    lastAvailableTag: presentString(row.last_available_tag),
    autoInstallId: presentString(row.auto_install_id),
    autoFirstSeenVersion: presentString(row.auto_first_seen_version),
    autoFirstSeenTag: presentString(row.auto_first_seen_tag),
    autoFirstSeenAt: presentString(row.auto_first_seen_at),
    autoLastAttemptVersion: presentString(row.auto_last_attempt_version),
    autoLastAttemptAt: presentString(row.auto_last_attempt_at),
    autoLastSuccessVersion: presentString(row.auto_last_success_version),
    autoLastSuccessAt: presentString(row.auto_last_success_at),
  };
}

async function writeState(state: UpdateCheckState): Promise<void> {
  const updatedAtMs = Date.now();
  runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<UpdateCheckStateDatabase>(db);
    executeSqliteQuerySync(
      db,
      stateDb.deleteFrom("update_check_state").where("state_key", "=", UPDATE_CHECK_STATE_KEY),
    );
    executeSqliteQuerySync(
      db,
      stateDb.insertInto("update_check_state").values({
        state_key: UPDATE_CHECK_STATE_KEY,
        last_checked_at: state.lastCheckedAt ?? null,
        last_notified_version: state.lastNotifiedVersion ?? null,
        last_notified_tag: state.lastNotifiedTag ?? null,
        last_available_version: state.lastAvailableVersion ?? null,
        last_available_tag: state.lastAvailableTag ?? null,
        auto_install_id: state.autoInstallId ?? null,
        auto_first_seen_version: state.autoFirstSeenVersion ?? null,
        auto_first_seen_tag: state.autoFirstSeenTag ?? null,
        auto_first_seen_at: state.autoFirstSeenAt ?? null,
        auto_last_attempt_version: state.autoLastAttemptVersion ?? null,
        auto_last_attempt_at: state.autoLastAttemptAt ?? null,
        auto_last_success_version: state.autoLastSuccessVersion ?? null,
        auto_last_success_at: state.autoLastSuccessAt ?? null,
        updated_at_ms: updatedAtMs,
      }),
    );
  });
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

function clearPersistedAvailabilityForChannel(
  nextState: UpdateCheckState,
  channel: UpdateChannel,
): void {
  if (!isPersistedAvailabilityForChannel({ state: nextState, channel })) {
    return;
  }
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

function resolveManagedAutoUpdateRestartDelayMs(supervisor: RespawnSupervisor): number {
  return supervisor === "systemd" ? MANAGED_AUTO_UPDATE_SYSTEMD_RESTART_GRACE_MS : 0;
}

async function startManagedServiceAutoUpdateHandoff(
  params: AutoUpdateRunParams & { supervisor: RespawnSupervisor },
): Promise<AutoUpdateRunResult> {
  const restartDelayMs = resolveManagedAutoUpdateRestartDelayMs(params.supervisor);
  const handoffId = randomUUID();
  try {
    if (!params.root?.trim()) {
      throw new Error("managed auto-update install root is unavailable");
    }
    const started = await startManagedServiceUpdateHandoff({
      root: params.root,
      timeoutMs: params.timeoutMs,
      restartDrainTimeoutMs: params.restartDrainTimeoutMs,
      channel: params.channel,
      ...(params.packageTargetVersion ? { tag: params.packageTargetVersion } : {}),
      restartDelayMs,
      supervisor: params.supervisor,
      handoffId,
      ...(params.devTarget ? { devTarget: params.devTarget } : {}),
      meta: {
        handoffId,
        note: "background auto-update",
      },
    });
    // Pair helper creation with restart scheduling before any state persistence
    // can fail and leave an indefinite handoff waiting on a live parent.
    if (started.status === "started") {
      scheduleGatewaySigusr1Restart({
        delayMs: restartDelayMs,
        reason: "update.auto",
        skipCooldown: true,
        skipDeferral: true,
      });
    }
    return {
      ok: true,
      code: 0,
      reason: CONTROL_PLANE_UPDATE_HANDOFF_STARTED_REASON,
      command: started.command,
      logPath: started.logPath,
    };
  } catch (err) {
    return {
      ok: false,
      code: null,
      reason: String(err),
    };
  }
}

async function runAutoUpdateCommand(params: AutoUpdateRunParams): Promise<AutoUpdateRunResult> {
  if (isGatewayExternallySupervised()) {
    return {
      ok: false,
      code: null,
      reason: EXTERNAL_SUPERVISOR_UPDATE_REQUIRED_REASON,
    };
  }
  const supervisor = detectRespawnSupervisor(process.env, process.platform, {
    includeLinuxOpenClawGatewayServiceMarker: true,
  });
  if (supervisor) {
    return await startManagedServiceAutoUpdateHandoff({
      channel: params.channel,
      timeoutMs: params.timeoutMs,
      restartDrainTimeoutMs: params.restartDrainTimeoutMs,
      root: params.root,
      ...(params.packageTargetVersion ? { packageTargetVersion: params.packageTargetVersion } : {}),
      ...(params.devTarget ? { devTarget: params.devTarget } : {}),
      supervisor,
    });
  }

  const targetArgs = [
    "--channel",
    params.channel,
    ...(params.packageTargetVersion ? ["--tag", params.packageTargetVersion] : []),
  ];
  const baseArgs = ["update", "--yes", ...targetArgs, "--json"];
  const execPath = process.execPath?.trim();
  const argv1 = process.argv[1]?.trim();
  const lowerExecBase = execPath ? normalizeLowercaseStringOrEmpty(path.basename(execPath)) : "";
  const runtimeIsNodeOrBun =
    lowerExecBase === "node" ||
    lowerExecBase === "node.exe" ||
    lowerExecBase === "bun" ||
    lowerExecBase === "bun.exe";
  const argv: string[] = [];
  if (execPath && argv1) {
    argv.push(execPath, argv1, ...baseArgs);
  } else if (execPath && !runtimeIsNodeOrBun) {
    argv.push(execPath, ...baseArgs);
  } else if (execPath && params.root) {
    const candidates = [
      path.join(params.root, "dist", "entry.js"),
      path.join(params.root, "dist", "entry.mjs"),
      path.join(params.root, "dist", "index.js"),
      path.join(params.root, "dist", "index.mjs"),
    ];
    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
        argv.push(execPath, candidate, ...baseArgs);
        break;
      } catch {
        // try next candidate
      }
    }
  }
  if (argv.length === 0) {
    argv.push("openclaw", ...baseArgs);
  }

  try {
    const res = await runCommandWithTimeout(argv, {
      timeoutMs: params.timeoutMs,
      ...(params.devTarget ? { env: applyDevUpdateTargetEnv({}, params.devTarget) } : {}),
    });
    return {
      ok: res.code === 0,
      code: res.code,
      stdout: res.stdout,
      stderr: res.stderr,
      reason: res.code === 0 ? undefined : "non-zero-exit",
    };
  } catch (err) {
    return {
      ok: false,
      code: null,
      reason: String(err),
    };
  }
}

function clearAutoState(nextState: UpdateCheckState): void {
  delete nextState.autoFirstSeenVersion;
  delete nextState.autoFirstSeenTag;
  delete nextState.autoFirstSeenAt;
}

async function resolveStartupInstallStatus(checkDevGit: boolean) {
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
    timeoutMs: 2500,
    fetchGit: checkDevGit,
    includeRegistry: false,
    ...(checkDevGit ? { useDetachedDevUpstream: true } : {}),
    ...(gitUpstreamFallback ? { gitUpstreamFallback } : {}),
  });
  return { root, status, installReceipt };
}

type GitScheduleStatus = NonNullable<NonNullable<UpdateScheduleState["install"]>["git"]>;

function gitCommitsMatch(left: string, right: string): boolean {
  const normalizedLeft = left.trim().toLowerCase();
  const normalizedRight = right.trim().toLowerCase();
  return (
    normalizedLeft.length >= 7 &&
    normalizedRight.length >= 7 &&
    (normalizedLeft.startsWith(normalizedRight) || normalizedRight.startsWith(normalizedLeft))
  );
}

function resolveGitInstalledAtMs(
  git: NonNullable<UpdateCheckResult["git"]>,
  installReceipt: VerifiedGitUpdateReceipt | null,
  root: string | null,
): number | undefined {
  return installReceipt &&
    root !== null &&
    updateInstallRootsMatch(root, installReceipt.root) &&
    git.sha &&
    gitCommitsMatch(installReceipt.sha, git.sha)
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
export async function refreshGatewayUpdateStatus(cfg: OpenClawConfig): Promise<void> {
  const channel = normalizeUpdateChannel(cfg.update?.channel) ?? DEFAULT_PACKAGE_CHANNEL;
  if (channel !== "dev") {
    return;
  }
  const { root, status, installReceipt } = await resolveStartupInstallStatus(true);
  const current =
    updateScheduleCache?.channel === channel
      ? updateScheduleCache
      : { channel, autoEnabled: Boolean(cfg.update?.auto?.enabled) };
  setUpdateScheduleCache({ next: withInstallStatus(current, status, true, installReceipt, root) });
}

async function resolveDevGitCommits(params: {
  root: string;
  currentSha: string;
  upstreamSha: string;
}): Promise<Array<{ sha: string; subject: string }>> {
  const result = await runCommandWithTimeout(
    [
      "git",
      "-C",
      params.root,
      "log",
      "--format=%h%x09%s",
      `--max-count=${DEV_COMMIT_LIMIT}`,
      `${params.currentSha}..${params.upstreamSha}`,
    ],
    {
      timeoutMs: 2500,
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

async function runCampaignUpdate(params: {
  channel: "stable" | "beta" | "dev";
  version: string;
  tag: string;
  forced: boolean;
  root?: string;
  devTarget?: TrackedDevUpdateTarget;
  log: { info: (msg: string, meta?: Record<string, unknown>) => void };
  runAuto: AutoUpdateRunner;
}): Promise<"handoff" | "applied" | "failed"> {
  const attemptAt = resolveUpdateCheckNowMs(Date.now());
  const attemptState = await readState();
  attemptState.autoLastAttemptVersion = params.version;
  attemptState.autoLastAttemptAt = resolveUpdateCheckTimestamp(attemptAt);
  await writeState(attemptState);

  const outcome = await params.runAuto({
    channel: params.channel,
    timeoutMs: AUTO_UPDATE_COMMAND_TIMEOUT_MS,
    restartDrainTimeoutMs: resolveGatewayRestartDeferralTimeoutMs(),
    ...(params.root ? { root: params.root } : {}),
    ...(params.channel === "dev" ? {} : { packageTargetVersion: params.version }),
    ...(params.devTarget ? { devTarget: params.devTarget } : {}),
  });
  if (outcome.ok && outcome.reason === CONTROL_PLANE_UPDATE_HANDOFF_STARTED_REASON) {
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
  if (outcome.ok) {
    const successState = await readState();
    successState.autoLastSuccessVersion = params.version;
    successState.autoLastSuccessAt = resolveUpdateCheckTimestamp(Date.now());
    await writeState(successState);
    params.log.info("auto-update applied", {
      channel: params.channel,
      version: params.version,
      tag: params.tag,
      forced: params.forced,
    });
    return "applied";
  }
  params.log.info("auto-update attempt failed", {
    channel: params.channel,
    version: params.version,
    tag: params.tag,
    forced: params.forced,
    reason: outcome.reason ?? `exit:${outcome.code}`,
  });
  return "failed";
}

export async function runGatewayUpdateCheck(params: {
  cfg: OpenClawConfig;
  log: { info: (msg: string, meta?: Record<string, unknown>) => void };
  isNixMode: boolean;
  allowInTests?: boolean;
  onUpdateAvailableChange?: (updateAvailable: UpdateAvailable | null) => void;
  onUpdateScheduleChange?: (schedule: UpdateScheduleState) => void;
  activeWorkInspectors?: Partial<GatewayActiveWorkInspectors>;
  updateCampaign?: UpdateCampaignController;
  runAutoUpdate?: AutoUpdateRunner;
}): Promise<void> {
  if (shouldSkipCheck(Boolean(params.allowInTests))) {
    return;
  }
  if (params.isNixMode) {
    return;
  }
  const configChannel = normalizeUpdateChannel(params.cfg.update?.channel);
  const updateCampaign = params.updateCampaign ?? gatewayUpdateCampaign;
  const auto = resolveAutoUpdatePolicy(params.cfg);
  const autoDisabledByEnv = isTruthyEnvValue(process.env.OPENCLAW_NO_AUTO_UPDATE);
  const autoDisabledByExternalSupervisor = isGatewayExternallySupervised();
  const shouldRunUpdateHints = params.cfg.update?.checkOnStart !== false;
  const potentialChannel = resolveEffectiveUpdateChannel({
    configChannel,
    currentVersion: VERSION,
    installKind: "package",
  }).channel;
  const potentialAutoDesired =
    (potentialChannel === "stable" || potentialChannel === "beta" || potentialChannel === "dev") &&
    auto.enabled &&
    !autoDisabledByEnv &&
    !autoDisabledByExternalSupervisor;
  if (!shouldRunUpdateHints && !potentialAutoDesired && configChannel === "extended-stable") {
    updateCampaign.clear();
    setUpdateAvailableCache({
      next: null,
      onUpdateAvailableChange: params.onUpdateAvailableChange,
    });
    const priorSchedule =
      updateScheduleCache?.channel === potentialChannel ? updateScheduleCache : null;
    const initialSchedule: UpdateScheduleState = priorSchedule
      ? { ...priorSchedule, autoEnabled: auto.enabled }
      : { channel: potentialChannel, autoEnabled: auto.enabled };
    setUpdateScheduleCache({
      next: withoutTarget(initialSchedule),
      onUpdateScheduleChange: params.onUpdateScheduleChange,
    });
    return;
  }
  const mightUseInstalledExtendedStableChannel =
    configChannel === null && potentialChannel === "extended-stable";
  let installStatus: Awaited<ReturnType<typeof resolveStartupInstallStatus>> | undefined;
  if (
    configChannel === "extended-stable" ||
    configChannel === "dev" ||
    mightUseInstalledExtendedStableChannel
  ) {
    installStatus = await resolveStartupInstallStatus(configChannel === "dev");
  }
  const configuredChannel = resolveEffectiveUpdateChannel({
    configChannel,
    currentVersion: VERSION,
    installKind: installStatus?.status.installKind ?? "unknown",
    git: installStatus?.status.git,
  }).channel;
  const autoDesired =
    (configuredChannel === "stable" ||
      configuredChannel === "beta" ||
      configuredChannel === "dev") &&
    auto.enabled &&
    !autoDisabledByEnv &&
    !autoDisabledByExternalSupervisor;

  if (updateScheduleCache?.channel !== configuredChannel) {
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

  if (!shouldRunUpdateHints && !autoDesired) {
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

  if ((configuredChannel === "extended-stable" || configuredChannel === "dev") && !installStatus) {
    installStatus = await resolveStartupInstallStatus(configuredChannel === "dev");
  }
  if (installStatus && (configuredChannel === "extended-stable" || configuredChannel === "dev")) {
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
  if (configuredChannel === "extended-stable" && installStatus) {
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
  if (!shouldRunUpdateHints && !shouldRunAutoUpdate) {
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

  const state = await readState();
  const rawNow = Date.now();
  const now = resolveUpdateCheckNowMs(rawNow);
  const rawNowIsValid = asDateTimestampMs(rawNow) !== undefined;
  const lastCheckedAt = state.lastCheckedAt ? Date.parse(state.lastCheckedAt) : null;
  const persistedAvailable =
    shouldRunUpdateHints && !isDevGit
      ? resolvePersistedUpdateAvailable(state, configuredChannel)
      : null;
  const hasExtendedStableCheckMarker = state.lastAvailableTag?.trim() === "extended-stable";
  const shouldBypassSharedThrottle =
    isDevGit || (configuredChannel === "extended-stable" && !hasExtendedStableCheckMarker);
  if (shouldRunUpdateHints) {
    setUpdateAvailableCache({
      next: persistedAvailable,
      onUpdateAvailableChange: params.onUpdateAvailableChange,
    });
  } else {
    setUpdateAvailableCache({
      next: null,
      onUpdateAvailableChange: params.onUpdateAvailableChange,
    });
  }
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

  installStatus ??= await resolveStartupInstallStatus(false);
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
  };

  if (isDevGit) {
    delete nextState.lastAvailableVersion;
    delete nextState.lastAvailableTag;
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
      await writeState(nextState);
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
    });

    const target: NonNullable<UpdateScheduleState["target"]> = {
      kind: "git",
      upstreamRef,
      upstreamSha,
      commitsBehind,
    };
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
      next: shouldRunUpdateHints ? nextAvailable : null,
      onUpdateAvailableChange: params.onUpdateAvailableChange,
    });
    setUpdateScheduleCache({
      next: { ...(updateScheduleCache ?? initialSchedule), target },
      onUpdateScheduleChange: params.onUpdateScheduleChange,
    });

    if (auto.enabled && autoDisabledByEnv) {
      params.log.info("auto-update disabled by OPENCLAW_NO_AUTO_UPDATE", {
        version: upstreamSha,
        tag: "dev",
      });
    }
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
        state.autoLastAttemptVersion === upstreamSha &&
        lastAttemptAt != null &&
        Number.isFinite(lastAttemptAt) &&
        now - lastAttemptAt < ONE_HOUR_MS;
      if (!recentAttempt) {
        const runAuto = params.runAutoUpdate ?? runAutoUpdateCommand;
        updateCampaign.announce({
          target,
          inspect: params.activeWorkInspectors,
          onChange: onCampaignChange,
          apply: async ({ forced }) =>
            await runCampaignUpdate({
              channel: "dev",
              version: upstreamSha,
              tag: "dev",
              forced,
              root: root ?? status.root ?? undefined,
              devTarget: devUpdateTargetFromGitCampaign(target),
              log: params.log,
              runAuto,
            }),
        });
      }
    } else {
      updateCampaign.clear();
    }
    await writeState(nextState);
    return;
  }

  if (status.installKind !== "package") {
    delete nextState.lastAvailableVersion;
    delete nextState.lastAvailableTag;
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
    await writeState(nextState);
    return;
  }

  const channel = configuredChannel;
  const resolved = await resolveNpmChannelTag({ channel, timeoutMs: 2500 });
  const tag = resolved.tag;
  if (!resolved.version) {
    if (channel === "extended-stable") {
      clearPersistedAvailabilityForChannel(nextState, channel);
      if (!nextState.lastAvailableVersion) {
        nextState.lastAvailableTag = channel;
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
    await writeState(nextState);
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
    setUpdateScheduleCache({
      next: { ...(updateScheduleCache ?? initialSchedule), target },
      onUpdateScheduleChange: params.onUpdateScheduleChange,
    });
    if (shouldRunUpdateHints) {
      setUpdateAvailableCache({
        next: nextAvailable,
        onUpdateAvailableChange: params.onUpdateAvailableChange,
      });
    }
    nextState.lastAvailableVersion = resolved.version;
    nextState.lastAvailableTag = tag;
    const shouldNotify =
      state.lastNotifiedVersion !== resolved.version || state.lastNotifiedTag !== tag;
    if (shouldRunUpdateHints && shouldNotify) {
      params.log.info(
        `update available (${tag}): v${resolved.version} (current v${VERSION}). Run: ${formatCliCommand("openclaw update")}`,
      );
      nextState.lastNotifiedVersion = resolved.version;
      nextState.lastNotifiedTag = tag;
    }

    if (channel !== "extended-stable" && auto.enabled && autoDisabledByEnv) {
      params.log.info("auto-update disabled by OPENCLAW_NO_AUTO_UPDATE", {
        version: resolved.version,
        tag,
      });
    }
    if (channel !== "extended-stable" && auto.enabled && autoDisabledByExternalSupervisor) {
      params.log.info("auto-update delegated to external supervisor", {
        version: resolved.version,
        tag,
        reason: EXTERNAL_SUPERVISOR_UPDATE_REQUIRED_REASON,
      });
    }

    if (shouldRunAutoUpdate && (channel === "stable" || channel === "beta")) {
      const runAuto = params.runAutoUpdate ?? runAutoUpdateCommand;
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
          apply: async ({ forced }) =>
            await runCampaignUpdate({
              channel,
              version: resolvedVersion,
              tag,
              forced,
              root: root ?? status.root ?? undefined,
              log: params.log,
              runAuto,
            }),
        });
      }
    }
  } else {
    if (channel === "extended-stable") {
      clearPersistedAvailabilityForChannel(nextState, channel);
      if (!nextState.lastAvailableVersion) {
        nextState.lastAvailableTag = channel;
      }
    } else {
      delete nextState.lastAvailableVersion;
      delete nextState.lastAvailableTag;
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

  await writeState(nextState);
}

export function scheduleGatewayUpdateCheck(params: {
  cfg: OpenClawConfig;
  log: { info: (msg: string, meta?: Record<string, unknown>) => void };
  isNixMode: boolean;
  onUpdateAvailableChange?: (updateAvailable: UpdateAvailable | null) => void;
  onUpdateScheduleChange?: (schedule: UpdateScheduleState) => void;
  activeWorkInspectors?: Partial<GatewayActiveWorkInspectors>;
}): () => void {
  const stopRemoteCatalogRefresh = scheduleRemoteModelCatalogRefresh(params);
  const channel = normalizeUpdateChannel(params.cfg.update?.channel) ?? DEFAULT_PACKAGE_CHANNEL;
  if (channel === "extended-stable" && params.cfg.update?.checkOnStart === false) {
    return () => {
      stopRemoteCatalogRefresh();
      gatewayUpdateCampaign.clear();
    };
  }
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  const tick = async () => {
    if (stopped || running) {
      return;
    }
    running = true;
    try {
      await runGatewayUpdateCheck(params);
    } catch {
      // Intentionally ignored: update checks should never crash the gateway loop.
    } finally {
      running = false;
    }
    if (stopped) {
      gatewayUpdateCampaign.clear();
      return;
    }
    const intervalMs = resolveCheckIntervalMs(params.cfg, updateScheduleCache?.install?.kind);
    timer = setTimeout(() => {
      void tick();
    }, intervalMs);
  };

  void tick();
  return () => {
    stopRemoteCatalogRefresh();
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    gatewayUpdateCampaign.clear();
  };
}

function scheduleRemoteModelCatalogRefresh(params: {
  cfg: OpenClawConfig;
  log: { info: (msg: string, meta?: Record<string, unknown>) => void };
}): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let activeAbortController: AbortController | null = null;
  const tick = async () => {
    if (stopped || running) {
      return;
    }
    running = true;
    const abortController = new AbortController();
    activeAbortController = abortController;
    const result = await refreshRemoteModelCatalog({
      config: params.cfg,
      signal: abortController.signal,
    });
    if (activeAbortController === abortController) {
      activeAbortController = null;
    }
    running = false;
    if (stopped) {
      return;
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
    const nextCheckInMs =
      result.status === "fresh" ? result.nextCheckInMs : REMOTE_MODEL_CATALOG_TTL_MS;
    timer = setTimeout(() => void tick(), nextCheckInMs);
    timer.unref?.();
  };
  void tick();
  return () => {
    stopped = true;
    activeAbortController?.abort();
    activeAbortController = null;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
