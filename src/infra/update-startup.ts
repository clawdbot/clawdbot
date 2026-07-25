// Runs startup update checks and optional auto-update handoff.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  asDateTimestampMs,
  timestampMsToIsoString,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runCommandWithTimeout } from "../process/exec.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { VERSION } from "../version.js";
import { isTruthyEnvValue } from "./env.js";
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
import {
  resolveGatewayRestartDeferralTimeoutMs,
  scheduleGatewaySigusr1Restart,
} from "./restart.js";
import { detectRespawnSupervisor, type RespawnSupervisor } from "./supervisor-markers.js";
import {
  channelToNpmTag,
  normalizeUpdateChannel,
  DEFAULT_PACKAGE_CHANNEL,
  type UpdateChannel,
} from "./update-channels.js";
import { compareSemverStrings, resolveNpmChannelTag, checkUpdateStatus } from "./update-check.js";
import { CONTROL_PLANE_UPDATE_HANDOFF_STARTED_REASON } from "./update-control-plane-sentinel.js";
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

export type UpdateAvailable = {
  currentVersion: string;
  latestVersion: string;
  channel: string;
};

let updateAvailableCache: UpdateAvailable | null = null;

export function getUpdateAvailable(): UpdateAvailable | null {
  return updateAvailableCache;
}

export function resetUpdateAvailableStateForTest(): void {
  updateAvailableCache = null;
}

const UPDATE_CHECK_STATE_KEY = "default";
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const AUTO_UPDATE_COMMAND_TIMEOUT_MS = 45 * 60 * 1000;
const AUTO_STABLE_DELAY_HOURS_DEFAULT = 6;
const AUTO_STABLE_JITTER_HOURS_DEFAULT = 12;
const AUTO_BETA_CHECK_INTERVAL_HOURS_DEFAULT = 1;
const MANAGED_AUTO_UPDATE_SYSTEMD_RESTART_GRACE_MS = 2000;

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

function resolveCheckIntervalMs(cfg: OpenClawConfig): number {
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
    a.channel === b.channel
  );
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

function resolveAutoUpdateHandoffRoot(root: string | undefined): string {
  if (root?.trim()) {
    return root;
  }
  try {
    return process.cwd();
  } catch {
    return os.homedir();
  }
}

function resolveManagedAutoUpdateRestartDelayMs(supervisor: RespawnSupervisor): number {
  return supervisor === "systemd" ? MANAGED_AUTO_UPDATE_SYSTEMD_RESTART_GRACE_MS : 0;
}

async function startManagedServiceAutoUpdateHandoff(params: {
  channel: "stable" | "beta";
  timeoutMs: number;
  restartDrainTimeoutMs: number | undefined;
  root?: string;
  supervisor: RespawnSupervisor;
}): Promise<AutoUpdateRunResult> {
  const restartDelayMs = resolveManagedAutoUpdateRestartDelayMs(params.supervisor);
  const handoffId = randomUUID();
  try {
    const started = await startManagedServiceUpdateHandoff({
      root: resolveAutoUpdateHandoffRoot(params.root),
      timeoutMs: params.timeoutMs,
      restartDrainTimeoutMs: params.restartDrainTimeoutMs,
      channel: params.channel,
      restartDelayMs,
      supervisor: params.supervisor,
      handoffId,
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

async function runAutoUpdateCommand(params: {
  channel: "stable" | "beta";
  timeoutMs: number;
  restartDrainTimeoutMs: number | undefined;
  root?: string;
}): Promise<AutoUpdateRunResult> {
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
      supervisor,
    });
  }

  const baseArgs = ["update", "--yes", "--channel", params.channel, "--json"];
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

async function resolveStartupInstallStatus() {
  const root = await resolveOpenClawPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
  const status = await checkUpdateStatus({
    root,
    timeoutMs: 2500,
    fetchGit: false,
    includeRegistry: false,
  });
  return { root, status };
}

export async function runGatewayUpdateCheck(params: {
  cfg: OpenClawConfig;
  log: { info: (msg: string, meta?: Record<string, unknown>) => void };
  isNixMode: boolean;
  allowInTests?: boolean;
  onUpdateAvailableChange?: (updateAvailable: UpdateAvailable | null) => void;
  runAutoUpdate?: (params: {
    channel: "stable" | "beta";
    timeoutMs: number;
    restartDrainTimeoutMs: number | undefined;
    root?: string;
  }) => Promise<AutoUpdateRunResult>;
}): Promise<void> {
  if (shouldSkipCheck(Boolean(params.allowInTests))) {
    return;
  }
  if (params.isNixMode) {
    return;
  }
  const configuredChannel =
    normalizeUpdateChannel(params.cfg.update?.channel) ?? DEFAULT_PACKAGE_CHANNEL;
  const auto = resolveAutoUpdatePolicy(params.cfg);
  const autoDisabledByEnv = isTruthyEnvValue(process.env.OPENCLAW_NO_AUTO_UPDATE);
  const autoDisabledByExternalSupervisor = isGatewayExternallySupervised();
  const isAutoUpdateChannel = configuredChannel === "stable" || configuredChannel === "beta";
  const shouldRunAutoUpdate =
    isAutoUpdateChannel && auto.enabled && !autoDisabledByEnv && !autoDisabledByExternalSupervisor;
  const shouldRunUpdateHints = params.cfg.update?.checkOnStart !== false;
  if (!shouldRunUpdateHints && !shouldRunAutoUpdate) {
    if (configuredChannel === "extended-stable") {
      setUpdateAvailableCache({
        next: null,
        onUpdateAvailableChange: params.onUpdateAvailableChange,
      });
    }
    return;
  }

  let installStatus: Awaited<ReturnType<typeof resolveStartupInstallStatus>> | undefined;
  if (configuredChannel === "extended-stable") {
    installStatus = await resolveStartupInstallStatus();
    if (installStatus.status.installKind !== "package") {
      setUpdateAvailableCache({
        next: null,
        onUpdateAvailableChange: params.onUpdateAvailableChange,
      });
      return;
    }
  }

  const state = await readState();
  const rawNow = Date.now();
  const now = resolveUpdateCheckNowMs(rawNow);
  const rawNowIsValid = asDateTimestampMs(rawNow) !== undefined;
  const lastCheckedAt = state.lastCheckedAt ? Date.parse(state.lastCheckedAt) : null;
  const persistedAvailable = shouldRunUpdateHints
    ? resolvePersistedUpdateAvailable(state, configuredChannel)
    : null;
  const hasExtendedStableCheckMarker = state.lastAvailableTag?.trim() === "extended-stable";
  const shouldBypassSharedThrottle =
    configuredChannel === "extended-stable" && !hasExtendedStableCheckMarker;
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
  const checkIntervalMs = shouldRunAutoUpdate
    ? resolveCheckIntervalMs(params.cfg)
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

  installStatus ??= await resolveStartupInstallStatus();
  const { root, status } = installStatus;

  const nextState: UpdateCheckState = {
    ...state,
    lastCheckedAt: resolveUpdateCheckTimestamp(now),
  };
  if (status.installKind !== "package") {
    delete nextState.lastAvailableVersion;
    delete nextState.lastAvailableTag;
    clearAutoState(nextState);
    setUpdateAvailableCache({
      next: null,
      onUpdateAvailableChange: params.onUpdateAvailableChange,
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
    }
    await writeState(nextState);
    return;
  }

  const cmp = compareSemverStrings(VERSION, resolved.version);
  if (cmp != null && cmp < 0) {
    const nextAvailable: UpdateAvailable = {
      currentVersion: VERSION,
      latestVersion: resolved.version,
      channel: tag,
    };
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
        nextState.autoLastAttemptVersion = resolved.version;
        nextState.autoLastAttemptAt = resolveUpdateCheckTimestamp(now);
        const outcome = await runAuto({
          channel,
          timeoutMs: AUTO_UPDATE_COMMAND_TIMEOUT_MS,
          restartDrainTimeoutMs: resolveGatewayRestartDeferralTimeoutMs(),
          root: root ?? status.root ?? undefined,
        });
        if (outcome.ok && outcome.reason === CONTROL_PLANE_UPDATE_HANDOFF_STARTED_REASON) {
          params.log.info("auto-update handoff started", {
            channel,
            version: resolved.version,
            tag,
            ...(outcome.command ? { command: outcome.command } : {}),
            ...(outcome.logPath ? { logPath: outcome.logPath } : {}),
          });
        } else if (outcome.ok) {
          nextState.autoLastSuccessVersion = resolved.version;
          nextState.autoLastSuccessAt = resolveUpdateCheckTimestamp(now);
          params.log.info("auto-update applied", {
            channel,
            version: resolved.version,
            tag,
          });
        } else {
          params.log.info("auto-update attempt failed", {
            channel,
            version: resolved.version,
            tag,
            reason: outcome.reason ?? `exit:${outcome.code}`,
          });
        }
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
  }

  await writeState(nextState);
}

export function scheduleGatewayUpdateCheck(params: {
  cfg: OpenClawConfig;
  log: { info: (msg: string, meta?: Record<string, unknown>) => void };
  isNixMode: boolean;
  onUpdateAvailableChange?: (updateAvailable: UpdateAvailable | null) => void;
}): () => void {
  const channel = normalizeUpdateChannel(params.cfg.update?.channel) ?? DEFAULT_PACKAGE_CHANNEL;
  if (channel === "extended-stable" && params.cfg.update?.checkOnStart === false) {
    return () => {};
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
      return;
    }
    const intervalMs = resolveCheckIntervalMs(params.cfg);
    timer = setTimeout(() => {
      void tick();
    }, intervalMs);
  };

  void tick();
  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
