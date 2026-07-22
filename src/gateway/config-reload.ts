import { homedir } from "node:os";
import nodePath from "node:path";
// Gateway config hot-reload watcher.
// Diffs config/plugin install snapshots and dispatches hot reload or restart plans.
import chokidar from "chokidar";
import type { ConfigRuntimeEnvPublication } from "../config/config-env-vars.js";
import {
  configSnapshotAuditRecordMatchesPath,
  fingerprintConfigSnapshotAuthoredConfig,
  readConfigSnapshotAuditRecord,
  readLatestConfigSnapshotAuditRecord,
  upsertConfigSnapshotAuditRecord,
} from "../config/config-journal-snapshot.js";
import {
  appendConfigAuditRecordSync,
  capConfigAuditIssues,
  capConfigAuditPaths,
  type ConfigExternalChangeAuditRecord,
} from "../config/io.audit.js";
import type { ConfigWriteNotification } from "../config/io.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import { hashRuntimeConfigValue, resolveConfigWriteFollowUp } from "../config/runtime-snapshot.js";
import type { RuntimeConfigSnapshotRefreshOptions } from "../config/runtime-snapshot.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  clearLoadInstalledPluginIndexInstallRecordsCache,
  loadInstalledPluginIndexInstallRecords,
  loadInstalledPluginIndexInstallRecordsSync,
} from "../plugins/installed-plugin-index-records.js";
import { bumpSkillsSnapshotVersion } from "../skills/runtime/refresh-state.js";
import { createConfigAppliedRevisionTracker } from "./config-applied-revision.js";
import { diffConfigPaths, diffGatewayReloadPaths } from "./config-diff.js";
import {
  buildGatewayReloadPlan,
  listPluginInstallTimestampMetadataPaths,
  listPluginInstallWholeRecordPaths,
  type GatewayReloadPlan,
} from "./config-reload-plan.js";
import { resolveGatewayReloadSettings } from "./config-reload-settings.js";
import type { GatewayHotReloadStatus } from "./config-reload-status.types.js";

export type { GatewayReloadPlan } from "./config-reload-plan.js";
const MISSING_CONFIG_RETRY_DELAY_MS = 150;
const MISSING_CONFIG_MAX_RETRIES = 2;

// Watcher 'error' events (for example EMFILE/ENOSPC inotify exhaustion) close
// the chokidar watcher. Re-create it with bounded backoff so a transient fault
// does not permanently kill config hot-reload. If all native retries are
// exhausted (typical when the host has insufficient inotify watches), fall
// back to polling mode before giving up entirely.
const WATCHER_RECREATE_MAX_RETRIES = 3;
const WATCHER_RECREATE_BACKOFF_MS = [500, 2000, 5000] as const;

function resolveChokidarUsePolling(degradedToPolling: boolean): boolean {
  const envPoll = process.env.CHOKIDAR_USEPOLLING;
  if (envPoll !== undefined) {
    const envLower = envPoll.toLowerCase();
    if (envLower === "false" || envLower === "0") {
      return false;
    }
    if (envLower === "true" || envLower === "1") {
      return true;
    }
    return Boolean(envLower);
  }
  return Boolean(process.env.VITEST) || degradedToPolling;
}

/**
 * Paths under `skills.*` always change the snapshot that sessions cache in
 * sessions.json. Any prefix match here (for example `skills.allowBundled`,
 * `skills.entries.X.enabled`, `skills.profile`) forces sessions to rebuild
 * their snapshot on the next turn rather than silently advertising stale
 * tools to the model.
 */
const SKILLS_INVALIDATION_PREFIXES = ["skills"] as const;

function matchesSkillsInvalidationPrefix(path: string): boolean {
  return SKILLS_INVALIDATION_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}.`),
  );
}

function firstSkillsChangedPath(changedPaths: string[]): string | undefined {
  return changedPaths.find(matchesSkillsInvalidationPrefix);
}

function isNoopReloadPlan(plan: GatewayReloadPlan): boolean {
  return (
    !plan.restartGateway &&
    plan.hotReasons.length === 0 &&
    !plan.reloadHooks &&
    !plan.restartGmailWatcher &&
    !plan.restartCron &&
    !plan.restartHeartbeat &&
    !plan.restartHealthMonitor &&
    !plan.reloadPlugins &&
    !plan.disposeMcpRuntimes &&
    plan.restartChannels.size === 0 &&
    (plan.restartChannelAccounts?.size ?? 0) === 0
  );
}

type GatewayConfigReloader = {
  stop: () => Promise<void>;
  hotReloadStatus: () => GatewayHotReloadStatus;
  notifyPluginMetadataChanged: () => void;
};

type PluginInstallRecords = Record<string, PluginInstallRecord>;

type InProcessConfigCandidate = {
  config: OpenClawConfig;
  compareConfig: OpenClawConfig;
  persistedHash: string;
  afterWrite?: ConfigWriteNotification["afterWrite"];
  preparedCandidate?: ConfigWriteNotification["preparedCandidate"];
  runtimeRefresh?: RuntimeConfigSnapshotRefreshOptions;
  epoch: number;
};

export type GatewayConfigReloadTransactionOwnership = {
  isCurrent: () => boolean;
  markRuntimeCommitted: (runtimeConfig: OpenClawConfig, plan: GatewayReloadPlan) => void;
  commitRuntimeEnv: () => void;
  publishRuntimeEnv: () => void;
  rollbackRuntimeEnv: () => void;
  reapplyRuntimeOverlays: (config: OpenClawConfig) => OpenClawConfig;
  runtimeEnv?: NonNullable<ConfigWriteNotification["preparedCandidate"]>["runtimeEnv"];
  runtimeRefresh?: RuntimeConfigSnapshotRefreshOptions;
};

type PreparedGatewayConfigCandidate = {
  runtimeConfig: OpenClawConfig;
  compareConfig: OpenClawConfig;
  runtimeEnv?: NonNullable<ConfigWriteNotification["preparedCandidate"]>["runtimeEnv"];
  reapplyRuntimeOverlays?: (config: OpenClawConfig) => OpenClawConfig;
  reapplyCompareOverlays?: (config: OpenClawConfig) => OpenClawConfig;
};

class GatewayConfigReloadSupersededError extends Error {
  constructor() {
    super("config reload superseded by a newer config write");
    this.name = "GatewayConfigReloadSupersededError";
  }
}

function isGatewayConfigReloadSupersededError(error: unknown): boolean {
  return error instanceof Error && error.name === "GatewayConfigReloadSupersededError";
}

function asPluginInstallConfig(records: PluginInstallRecords): OpenClawConfig {
  return {
    plugins: {
      installs: records,
    },
  };
}

export function startGatewayConfigReloader(opts: {
  initialConfig: OpenClawConfig;
  initialCompareConfig?: OpenClawConfig;
  initialSnapshotRawHash: string | null;
  initialAuthoredConfig: unknown;
  initialIncludedPaths?: readonly string[];
  initialSnapshotValid: boolean;
  initialSnapshotIssues: ConfigFileSnapshot["issues"];
  /** Keeps watcher-heavy tests immediate without reopening config-level debounce tuning. */
  testDebounceMs?: number;
  /** Per-instance test hook for synchronizing filesystem edits with watcher startup. */
  onWatcherReady?: () => void;
  prepareConfigCandidate?: (params: {
    runtimeConfig: OpenClawConfig;
    sourceConfig: OpenClawConfig;
    previousSourceConfig: OpenClawConfig;
  }) => PreparedGatewayConfigCandidate;
  initialInternalWriteHash?: string | null;
  readSnapshot: (activeSourceConfig: OpenClawConfig) => Promise<ConfigFileSnapshot>;
  /** Pauses restart emission synchronously when a matching disk candidate is observed. */
  onConfigCandidateObserved?: () => void;
  onConfigChange?: (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => void | Promise<void>;
  /** Publishes runtime state after a hot or no-op config transaction. */
  onConfigApplied?: (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => void | Promise<void>;
  /** Publishes the resolved source-config revision accepted by the active runtime. */
  onConfigRevisionApplied?: (hash: string) => void;
  /** Retires rejected lifecycle work after any newer config transaction is accepted. */
  onConfigAccepted?: (
    nextConfig: OpenClawConfig,
    ownership: GatewayConfigReloadTransactionOwnership,
    sourceConfig: OpenClawConfig,
    acceptance: {
      runtimeApplied: boolean;
      publishSource?: () => Promise<() => Promise<void>>;
    },
  ) => void | (() => Promise<void>) | Promise<void | (() => Promise<void>)>;
  /** Publishes a newer source snapshot when effective runtime bytes are unchanged. */
  onEffectiveConfigUnchanged?: (
    nextConfig: OpenClawConfig,
    ownership: GatewayConfigReloadTransactionOwnership,
    sourceConfig: OpenClawConfig,
  ) => Promise<{
    rollback: () => Promise<void>;
    /** Runs only when this exact source publication can no longer roll back. */
    commit?: () => void;
  }>;
  /**
   * Fires once per accepted candidate whose persisted content changed —
   * regardless of writer (gateway RPC, agent/CLI config_set, doctor, hand
   * edit) and of whether the runtime applied it. The single notification
   * point for change listeners such as the config.changed broadcast.
   */
  onConfigCandidateCommitted?: (info: {
    path: string;
    persistedHash: string | null;
    changedPaths: readonly string[];
  }) => void;
  onNoopConfigCommit: (
    plan: GatewayReloadPlan,
    nextConfig: OpenClawConfig,
    ownership: GatewayConfigReloadTransactionOwnership,
    sourceConfig: OpenClawConfig,
  ) => Promise<void>;
  onHotReload: (
    plan: GatewayReloadPlan,
    nextConfig: OpenClawConfig,
    ownership: GatewayConfigReloadTransactionOwnership,
    sourceConfig: OpenClawConfig,
  ) => Promise<void>;
  onRestart: (
    plan: GatewayReloadPlan,
    nextConfig: OpenClawConfig,
    ownership: GatewayConfigReloadTransactionOwnership,
    sourceConfig: OpenClawConfig,
  ) => void | Promise<void>;
  /** Keeps one accepted config transaction inside the Gateway work fence. */
  runTransaction?: <T>(run: () => Promise<T>) => Promise<T>;
  promoteSnapshot?: (snapshot: ConfigFileSnapshot, reason: string) => Promise<boolean>;
  initialPluginInstallRecords?: PluginInstallRecords;
  readPluginInstallRecords?: () => Promise<PluginInstallRecords>;
  subscribeToWrites?: (listener: (event: ConfigWriteNotification) => void) => () => void;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  watchPath: string;
}): GatewayConfigReloader {
  const initialSourceConfig = opts.initialCompareConfig ?? opts.initialConfig;
  const initialCandidate = opts.prepareConfigCandidate?.({
    runtimeConfig: opts.initialConfig,
    sourceConfig: initialSourceConfig,
    previousSourceConfig: initialSourceConfig,
  });
  let currentConfig = initialCandidate?.runtimeConfig ?? opts.initialConfig;
  let currentCompareConfig = initialCandidate?.compareConfig ?? initialSourceConfig;
  let currentSourceConfig = initialSourceConfig;
  let currentRawHash = opts.initialSnapshotRawHash;
  let lastObservedRawHash = opts.initialSnapshotRawHash;
  let currentFingerprintedAuthoredConfig = fingerprintConfigSnapshotAuthoredConfig(
    opts.initialAuthoredConfig,
    { env: process.env, homedir },
  );
  let currentRuntimeEnvSourceConfig = initialSourceConfig;
  let currentReapplyRuntimeOverlays =
    initialCandidate?.reapplyRuntimeOverlays ?? ((config: OpenClawConfig) => config);
  let currentRuntimeRefresh: RuntimeConfigSnapshotRefreshOptions | undefined;
  const resolveSettings = (config: OpenClawConfig) => {
    const resolved = resolveGatewayReloadSettings(config);
    return opts.testDebounceMs === undefined
      ? resolved
      : { ...resolved, debounceMs: opts.testDebounceMs };
  };
  let settings = resolveSettings(currentConfig);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  let running = false;
  let stopped = false;
  const activeReloads = new Set<Promise<void>>();
  let missingConfigRetries = 0;
  let configWriteEpoch = 0;
  let pendingInProcessConfig: InProcessConfigCandidate | null = null;
  let activeInProcessConfig: InProcessConfigCandidate | null = null;
  let watcherIntentCandidate: InProcessConfigCandidate | null = null;
  let startupInternalWriteHash = opts.initialInternalWriteHash ?? null;
  let lastAppliedWriteHash: string | null = null;
  let lastSourceOnlyWriteHash: string | null = null;
  let lastSourceOnlyReapplyRuntimeOverlays: ((config: OpenClawConfig) => OpenClawConfig) | null =
    null;
  let lastSourceOnlyRuntimeRefresh: RuntimeConfigSnapshotRefreshOptions | undefined;
  let lastSourceOnlyRuntimeConfig: OpenClawConfig | null = null;
  let lastSourceOnlySourceConfig: OpenClawConfig | null = null;

  const appendExternalAudit = (
    record: Omit<ConfigExternalChangeAuditRecord, "ts" | "source" | "event" | "configPath">,
  ) => {
    appendConfigAuditRecordSync({
      env: process.env,
      homedir,
      record: {
        ts: new Date().toISOString(),
        source: "config-io",
        event: "config.external",
        configPath: opts.watchPath,
        ...record,
      },
    });
  };

  // CAS token is the unfiltered slot: a slot owned by another config path must
  // still be the expected value so this path can take the slot over. Only a
  // path-matched slot may seed reconcile baselines.
  let currentSnapshotSlot = readLatestConfigSnapshotAuditRecord();

  const updateAcceptedSnapshot = (rawHash: string, authoredConfig: unknown) => {
    currentRawHash = rawHash;
    currentFingerprintedAuthoredConfig = fingerprintConfigSnapshotAuthoredConfig(authoredConfig, {
      env: process.env,
      homedir,
    });
    const updatedSlot = upsertConfigSnapshotAuditRecord({
      configPath: opts.watchPath,
      rawHash,
      authoredConfig,
      expectedSnapshot: currentSnapshotSlot,
    });
    if (updatedSlot) {
      currentSnapshotSlot = updatedSlot;
      return;
    }
    currentSnapshotSlot = readLatestConfigSnapshotAuditRecord();
    if (configSnapshotAuditRecordMatchesPath(currentSnapshotSlot, opts.watchPath)) {
      currentRawHash = currentSnapshotSlot.rawHash;
      currentFingerprintedAuthoredConfig = currentSnapshotSlot.fingerprintedAuthoredConfig;
    }
  };

  const priorSnapshot = configSnapshotAuditRecordMatchesPath(currentSnapshotSlot, opts.watchPath)
    ? currentSnapshotSlot
    : null;
  if (priorSnapshot && opts.initialSnapshotRawHash === null) {
    currentRawHash = priorSnapshot.rawHash;
    currentFingerprintedAuthoredConfig = priorSnapshot.fingerprintedAuthoredConfig;
    appendExternalAudit({
      detectedBy: "startup",
      previousHash: priorSnapshot.rawHash,
      nextHash: null,
      valid: false,
      issues: capConfigAuditIssues(["config file missing"]),
    });
  } else if (priorSnapshot && priorSnapshot.rawHash !== opts.initialSnapshotRawHash) {
    if (!opts.initialSnapshotValid) {
      currentRawHash = priorSnapshot.rawHash;
      currentFingerprintedAuthoredConfig = priorSnapshot.fingerprintedAuthoredConfig;
    }
    const startupChangedPaths = opts.initialSnapshotValid
      ? diffConfigPaths(
          priorSnapshot.fingerprintedAuthoredConfig,
          fingerprintConfigSnapshotAuthoredConfig(opts.initialAuthoredConfig, {
            env: process.env,
            homedir,
          }),
        )
      : [];
    appendExternalAudit({
      detectedBy: "startup",
      previousHash: priorSnapshot.rawHash,
      nextHash: opts.initialSnapshotRawHash,
      valid: opts.initialSnapshotValid,
      ...(!opts.initialSnapshotValid
        ? {
            issues: capConfigAuditIssues(
              formatConfigIssueLines(opts.initialSnapshotIssues, "", { normalizeRoot: true }),
            ),
          }
        : startupChangedPaths.length > 0
          ? { changedPaths: capConfigAuditPaths(startupChangedPaths) }
          : { opaqueChange: true }),
    });
  }
  if (opts.initialSnapshotRawHash !== null && opts.initialSnapshotValid) {
    updateAcceptedSnapshot(opts.initialSnapshotRawHash, opts.initialAuthoredConfig);
  }
  let currentPluginInstallRecords =
    opts.initialPluginInstallRecords ?? loadInstalledPluginIndexInstallRecordsSync();
  const readPluginInstallRecords =
    opts.readPluginInstallRecords ?? loadInstalledPluginIndexInstallRecords;
  const appliedRevision = createConfigAppliedRevisionTracker({
    onConfigApplied: opts.onConfigApplied,
    onRevisionApplied: opts.onConfigRevisionApplied,
  });

  const scheduleAfter = (wait: number) => {
    if (stopped) {
      return;
    }
    // Coalesce filesystem/write-listener bursts into one reload pass. Config
    // writes often touch temp and final paths in quick succession.
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      startTrackedReload();
    }, wait);
  };
  const schedule = () => {
    scheduleAfter(settings.debounceMs);
  };
  const prepareRestart = async (
    plan: GatewayReloadPlan,
    nextConfig: OpenClawConfig,
    ownership: GatewayConfigReloadTransactionOwnership,
    sourceConfig: OpenClawConfig,
  ) => {
    try {
      // Every accepted restart candidate validates inside its config
      // transaction. Only downstream signal delivery may coalesce.
      await opts.onRestart(plan, nextConfig, ownership, sourceConfig);
    } catch (err) {
      if (isGatewayConfigReloadSupersededError(err)) {
        opts.log.info(`config restart superseded: ${String(err)}`);
      } else {
        opts.log.error(`config restart failed: ${String(err)}`);
      }
      // Failed restart admission must reject the transaction. Otherwise the
      // persisted snapshot becomes the baseline and the same config cannot retry.
      throw err;
    }
  };

  const handleMissingSnapshot = (snapshot: ConfigFileSnapshot): boolean => {
    if (snapshot.exists) {
      missingConfigRetries = 0;
      return false;
    }
    if (missingConfigRetries < MISSING_CONFIG_MAX_RETRIES) {
      missingConfigRetries += 1;
      opts.log.info(
        `config reload retry (${missingConfigRetries}/${MISSING_CONFIG_MAX_RETRIES}): config file not found`,
      );
      scheduleAfter(MISSING_CONFIG_RETRY_DELAY_MS);
      return true;
    }
    opts.log.warn("config reload skipped (config file not found)");
    return true;
  };

  const handleInvalidSnapshot = (snapshot: ConfigFileSnapshot): boolean => {
    if (snapshot.valid) {
      return false;
    }
    const issues = formatConfigIssueLines(snapshot.issues, "").join(", ");
    opts.log.warn(`config reload skipped (invalid config): ${issues}`);
    return true;
  };

  const applySnapshot = async (
    candidateRuntimeConfig: OpenClawConfig,
    nextSourceConfig: OpenClawConfig,
    afterWrite?: ConfigWriteNotification["afterWrite"],
    transactionEpoch = configWriteEpoch,
    persistedHash?: string,
    preflightCandidate?: ConfigWriteNotification["preparedCandidate"],
    runtimeRefresh?: RuntimeConfigSnapshotRefreshOptions,
    authoredConfig?: unknown,
  ) => {
    // Reprepare against the current accepted env owner. A managed write can
    // finish preflight while another watcher transaction accepts first.
    const preparedCandidate =
      opts.prepareConfigCandidate?.({
        runtimeConfig: candidateRuntimeConfig,
        sourceConfig: nextSourceConfig,
        previousSourceConfig: currentRuntimeEnvSourceConfig,
      }) ?? preflightCandidate;
    const nextConfig = preparedCandidate?.runtimeConfig ?? candidateRuntimeConfig;
    const nextCompareConfig = preparedCandidate?.compareConfig ?? nextSourceConfig;
    const nextConfigRevisionHash = hashRuntimeConfigValue(nextSourceConfig);
    let nextPluginInstallRecords = currentPluginInstallRecords;
    let committedRuntimeConfig: OpenClawConfig | null = null;
    let publishedRuntimeEnv: ConfigRuntimeEnvPublication | undefined;
    let runtimeEnvCommitted = false;
    const nextSettings = resolveSettings(nextConfig);
    const isCurrent = () => configWriteEpoch === transactionEpoch;
    const assertCurrent = () => {
      if (!isCurrent()) {
        throw new GatewayConfigReloadSupersededError();
      }
    };
    const commitPublishedRuntimeEnv = () => {
      runtimeEnvCommitted = true;
      publishedRuntimeEnv?.commit();
      publishedRuntimeEnv = undefined;
    };
    const ownership: GatewayConfigReloadTransactionOwnership = {
      isCurrent,
      reapplyRuntimeOverlays: preparedCandidate?.reapplyRuntimeOverlays ?? ((config) => config),
      ...(preparedCandidate?.runtimeEnv ? { runtimeEnv: preparedCandidate.runtimeEnv } : {}),
      ...(runtimeRefresh ? { runtimeRefresh } : {}),
      publishRuntimeEnv: () => {
        assertCurrent();
        if (runtimeEnvCommitted) {
          return;
        }
        publishedRuntimeEnv ??= preparedCandidate?.runtimeEnv?.publish();
        assertCurrent();
      },
      rollbackRuntimeEnv: () => {
        if (runtimeEnvCommitted) {
          return;
        }
        publishedRuntimeEnv?.();
        publishedRuntimeEnv = undefined;
      },
      commitRuntimeEnv: commitPublishedRuntimeEnv,
      markRuntimeCommitted: (runtimeConfig, plan) => {
        // Publication can win immediately before a watcher supersedes this
        // transaction. Advance the runtime diff baseline at that exact edge so
        // the newer disk config plans the reverse work instead of diffing stale state.
        commitPublishedRuntimeEnv();
        committedRuntimeConfig = runtimeConfig;
        currentConfig = runtimeConfig;
        currentCompareConfig = nextCompareConfig;
        currentSourceConfig = nextSourceConfig;
        currentRuntimeEnvSourceConfig = nextSourceConfig;
        currentReapplyRuntimeOverlays = ownership.reapplyRuntimeOverlays;
        currentRuntimeRefresh = ownership.runtimeRefresh;
        currentPluginInstallRecords = nextPluginInstallRecords;
        settings = resolveSettings(runtimeConfig);
        appliedRevision.defer(plan, nextConfigRevisionHash);
      },
    };
    const configChangedPaths = diffGatewayReloadPaths(currentCompareConfig, nextCompareConfig);
    const configPluginInstallTimestampNoopPaths = listPluginInstallTimestampMetadataPaths(
      currentCompareConfig,
      nextCompareConfig,
    );
    const configPluginInstallWholeRecordPaths = listPluginInstallWholeRecordPaths(
      currentCompareConfig,
      nextCompareConfig,
    );
    try {
      nextPluginInstallRecords = await readPluginInstallRecords();
    } catch (err) {
      opts.log.warn(`config reload plugin install record check failed: ${String(err)}`);
    }
    assertCurrent();
    const previousPluginInstallConfig = asPluginInstallConfig(currentPluginInstallRecords);
    const nextPluginInstallConfig = asPluginInstallConfig(nextPluginInstallRecords);
    const pluginInstallRecordChangedPaths = diffConfigPaths(
      previousPluginInstallConfig,
      nextPluginInstallConfig,
    );
    const pluginInstallRecordTimestampNoopPaths = listPluginInstallTimestampMetadataPaths(
      previousPluginInstallConfig,
      nextPluginInstallConfig,
    );
    const pluginInstallRecordWholeRecordPaths = listPluginInstallWholeRecordPaths(
      previousPluginInstallConfig,
      nextPluginInstallConfig,
    );
    const changedPaths = [...configChangedPaths, ...pluginInstallRecordChangedPaths];
    const pluginInstallTimestampNoopPaths = [
      ...configPluginInstallTimestampNoopPaths,
      ...pluginInstallRecordTimestampNoopPaths,
    ];
    const pluginInstallWholeRecordPaths = [
      ...configPluginInstallWholeRecordPaths,
      ...pluginInstallRecordWholeRecordPaths,
    ];
    // Publication can be superseded after its runtime commit but before its
    // lifecycle owner is applied. Finish that owner before the next candidate
    // prepares state that acceptance or restart policy may discard.
    await appliedRevision.flush(currentConfig);
    assertCurrent();
    const commitReloadBaseline = async (
      options: {
        runtimeApplied?: boolean;
        publishSource?: () => Promise<() => Promise<void>>;
      } = {},
    ) => {
      assertCurrent();
      // A prior transaction may publish runtime state immediately before a
      // newer write supersedes it. Commit that runtime owner before accepting
      // a baseline-only candidate, which can discard prepared lifecycle state.
      await appliedRevision.flush(currentConfig);
      assertCurrent();
      // Persisted content changed even when the runtime skipped applying it
      // (writer intent, reload mode off): change listeners still refresh.
      const notifyCommitted = () => {
        if (changedPaths.length > 0) {
          opts.onConfigCandidateCommitted?.({
            path: opts.watchPath,
            persistedHash: persistedHash ?? null,
            changedPaths,
          });
        }
      };
      let rollbackAcceptedSource: (() => Promise<void>) | undefined;
      try {
        const acceptedSourceRollback = await opts.onConfigAccepted?.(
          committedRuntimeConfig ?? nextConfig,
          ownership,
          nextSourceConfig,
          {
            runtimeApplied: options.runtimeApplied !== false,
            ...(options.publishSource ? { publishSource: options.publishSource } : {}),
          },
        );
        if (typeof acceptedSourceRollback === "function") {
          rollbackAcceptedSource = acceptedSourceRollback;
        }
        assertCurrent();
        rollbackAcceptedSource ??= await options.publishSource?.();
        assertCurrent();
        currentSourceConfig = nextSourceConfig;
        if (typeof persistedHash === "string") {
          if (authoredConfig !== undefined) {
            updateAcceptedSnapshot(persistedHash, authoredConfig);
          } else {
            currentRawHash = persistedHash;
          }
        }
        if (options.runtimeApplied === false) {
          // Persisted-but-skipped candidates are not runtime truth. Keep the
          // effective baseline so a later safe edit cannot publish them indirectly.
          lastSourceOnlyWriteHash = persistedHash ?? null;
          lastSourceOnlyReapplyRuntimeOverlays = ownership.reapplyRuntimeOverlays;
          lastSourceOnlyRuntimeRefresh = ownership.runtimeRefresh;
          lastSourceOnlyRuntimeConfig = nextConfig;
          lastSourceOnlySourceConfig = nextSourceConfig;
          notifyCommitted();
          return;
        }
        // Runtime owners publish env at their commit edge. Keep this idempotent
        // fallback for effective-config-unchanged transactions without a
        // dedicated runtime publication callback.
        ownership.publishRuntimeEnv();
        currentRuntimeEnvSourceConfig = nextSourceConfig;
        if (persistedHash === lastSourceOnlyWriteHash) {
          lastSourceOnlyWriteHash = null;
          lastSourceOnlyReapplyRuntimeOverlays = null;
          lastSourceOnlyRuntimeRefresh = undefined;
          lastSourceOnlyRuntimeConfig = null;
          lastSourceOnlySourceConfig = null;
        }
        currentConfig = committedRuntimeConfig ?? nextConfig;
        currentCompareConfig = nextCompareConfig;
        currentReapplyRuntimeOverlays = ownership.reapplyRuntimeOverlays;
        currentRuntimeRefresh = ownership.runtimeRefresh;
        currentPluginInstallRecords = nextPluginInstallRecords;
        settings = committedRuntimeConfig ? resolveSettings(committedRuntimeConfig) : nextSettings;
        commitPublishedRuntimeEnv();
      } catch (error) {
        ownership.rollbackRuntimeEnv();
        await rollbackAcceptedSource?.();
        throw error;
      }
      notifyCommitted();
    };
    if (changedPaths.length === 0) {
      let publishedSource: { rollback: () => Promise<void>; commit?: () => void } | undefined;
      let publishedSourceRollback: (() => Promise<void>) | undefined;
      let publishedSourceRolledBack = false;
      const publishSource = opts.onEffectiveConfigUnchanged
        ? async () => {
            publishedSource ??= await opts.onEffectiveConfigUnchanged!(
              nextConfig,
              ownership,
              nextSourceConfig,
            );
            publishedSourceRollback ??= async () => {
              publishedSourceRolledBack = true;
              await publishedSource?.rollback();
            };
            return publishedSourceRollback;
          }
        : undefined;
      await commitReloadBaseline(publishSource ? { publishSource } : {});
      if (!publishedSourceRolledBack) {
        publishedSource?.commit?.();
      }
      opts.onConfigRevisionApplied?.(nextConfigRevisionHash);
      return;
    }

    // Invalidate cached skills snapshots (persisted in sessions.json) whenever
    // the user touches skills.* config. Without this, sessions keep advertising
    // tools that no longer exist in the allowlist, which causes infinite
    // tool-not-found loops against the model.
    const skillsChangedPath = firstSkillsChangedPath(changedPaths);
    if (skillsChangedPath !== undefined) {
      bumpSkillsSnapshotVersion({ reason: "config-change", changedPath: skillsChangedPath });
      opts.log.info(`skills snapshot invalidated by config change (${skillsChangedPath})`);
    }

    const followUp = resolveConfigWriteFollowUp(afterWrite);
    opts.log.info(`config change detected; evaluating reload (${changedPaths.join(", ")})`);
    if (followUp.mode === "none") {
      opts.log.info(`config reload skipped by writer intent (${followUp.reason})`);
      await commitReloadBaseline({ runtimeApplied: false });
      return;
    }
    const plan = buildGatewayReloadPlan(changedPaths, {
      noopPaths: pluginInstallTimestampNoopPaths,
      forceChangedPaths: pluginInstallWholeRecordPaths,
      candidateConfig: nextConfig,
    });
    if (nextSettings.mode === "off") {
      opts.log.info("config reload disabled (gateway.reload.mode=off)");
      await commitReloadBaseline({ runtimeApplied: false });
      return;
    }
    if (isNoopReloadPlan(plan) && !followUp.requiresRestart) {
      await opts.onConfigChange?.(plan, nextConfig);
      // No-op plans still change the runtime config snapshot. Commit before
      // marking applied so getRuntimeConfig() readers do not stay stale until restart.
      await opts.onNoopConfigCommit(plan, nextConfig, ownership, nextSourceConfig);
      assertCurrent();
      await appliedRevision.apply(plan, nextConfig, nextConfigRevisionHash);
      await commitReloadBaseline();
      return;
    }
    if (followUp.requiresRestart) {
      const restartPlan = {
        ...plan,
        restartGateway: true,
        restartReasons: [...plan.restartReasons, followUp.reason],
      };
      await opts.onConfigChange?.(restartPlan, nextConfig);
      await prepareRestart(restartPlan, nextConfig, ownership, nextSourceConfig);
      await commitReloadBaseline();
      return;
    }
    if (plan.restartGateway) {
      await opts.onConfigChange?.(plan, nextConfig);
      await prepareRestart(plan, nextConfig, ownership, nextSourceConfig);
      await commitReloadBaseline();
      return;
    }

    await opts.onConfigChange?.(plan, nextConfig);
    try {
      await opts.onHotReload(plan, nextConfig, ownership, nextSourceConfig);
    } catch (error) {
      ownership.rollbackRuntimeEnv();
      throw error;
    }
    assertCurrent();
    await appliedRevision.apply(plan, nextConfig, nextConfigRevisionHash);
    await commitReloadBaseline();
  };

  const promoteAcceptedSnapshot = async (snapshot: ConfigFileSnapshot, reason: string) => {
    if (!opts.promoteSnapshot || !snapshot.exists || !snapshot.valid) {
      return;
    }
    try {
      await opts.promoteSnapshot(snapshot, reason);
    } catch (err) {
      opts.log.warn(`config reload last-known-good promotion failed: ${String(err)}`);
    }
  };

  const runAcceptedTransaction = async (run: () => Promise<void>) => {
    if (opts.runTransaction) {
      await opts.runTransaction(run);
      return;
    }
    await run();
  };

  const acceptCurrentRuntimeEcho = async (
    transactionEpoch: number,
    snapshot?: ConfigFileSnapshot,
  ) => {
    const ownership: GatewayConfigReloadTransactionOwnership = {
      isCurrent: () => configWriteEpoch === transactionEpoch,
      reapplyRuntimeOverlays: currentReapplyRuntimeOverlays,
      publishRuntimeEnv: () => {},
      rollbackRuntimeEnv: () => {},
      commitRuntimeEnv: () => {},
      ...(currentRuntimeRefresh ? { runtimeRefresh: currentRuntimeRefresh } : {}),
      markRuntimeCommitted: () => {},
    };
    await runAcceptedTransaction(async () => {
      await appliedRevision.flush(currentConfig);
      if (!ownership.isCurrent()) {
        throw new GatewayConfigReloadSupersededError();
      }
      await opts.onConfigAccepted?.(currentConfig, ownership, currentSourceConfig, {
        runtimeApplied: true,
      });
      if (!ownership.isCurrent()) {
        throw new GatewayConfigReloadSupersededError();
      }
      if (snapshot?.valid && typeof snapshot.hash === "string") {
        updateAcceptedSnapshot(snapshot.hash, snapshot.parsed);
      }
    });
    if (snapshot?.valid) {
      await acceptWatchedPaths(snapshot.includedPaths ?? []);
    }
  };

  const promoteAcceptedInProcessWrite = async (persistedHash: string) => {
    try {
      const snapshot = await opts.readSnapshot(currentRuntimeEnvSourceConfig);
      if (snapshot.hash !== persistedHash || !snapshot.valid) {
        return;
      }
      updateAcceptedSnapshot(snapshot.hash, snapshot.parsed);
      await acceptWatchedPaths(snapshot.includedPaths ?? []);
      await promoteAcceptedSnapshot(snapshot, "in-process-write");
    } catch (err) {
      opts.log.warn(`config reload in-process last-known-good promotion failed: ${String(err)}`);
    }
  };

  const runReload = async () => {
    if (stopped) {
      return;
    }
    if (running) {
      pending = true;
      return;
    }
    running = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    try {
      if (pendingInProcessConfig) {
        const pendingWrite = pendingInProcessConfig;
        pendingInProcessConfig = null;
        activeInProcessConfig = pendingWrite;
        missingConfigRetries = 0;
        try {
          await runAcceptedTransaction(async () => {
            await applySnapshot(
              pendingWrite.config,
              pendingWrite.compareConfig,
              pendingWrite.afterWrite,
              pendingWrite.epoch,
              pendingWrite.persistedHash,
              pendingWrite.preparedCandidate,
              pendingWrite.runtimeRefresh,
            );
            if (activeInProcessConfig === pendingWrite) {
              activeInProcessConfig = null;
            }
            await promoteAcceptedInProcessWrite(pendingWrite.persistedHash);
          });
        } catch (err) {
          if (lastAppliedWriteHash === pendingWrite.persistedHash) {
            lastAppliedWriteHash = null;
          }
          if (
            configWriteEpoch === pendingWrite.epoch &&
            !pendingInProcessConfig &&
            !watcherIntentCandidate
          ) {
            watcherIntentCandidate = pendingWrite;
          }
          throw err;
        } finally {
          if (activeInProcessConfig === pendingWrite) {
            activeInProcessConfig = null;
          }
        }
        return;
      }
      const transactionEpoch = configWriteEpoch;
      const intentCandidate = watcherIntentCandidate;
      const snapshot = await opts.readSnapshot(currentRuntimeEnvSourceConfig);
      if (configWriteEpoch !== transactionEpoch) {
        throw new GatewayConfigReloadSupersededError();
      }
      if (handleMissingSnapshot(snapshot)) {
        await appliedRevision.flush(currentConfig);
        return;
      }
      await observeCandidateWatchedPaths(snapshot.includedPaths ?? []);
      const observedRawHash = snapshot.hash ?? null;
      const previousObservedRawHash = lastObservedRawHash;
      const newObservedRawHash = observedRawHash !== previousObservedRawHash;
      lastObservedRawHash = observedRawHash;
      if (startupInternalWriteHash && typeof snapshot.hash === "string") {
        const matchesStartupWrite =
          snapshot.valid &&
          snapshot.hash === startupInternalWriteHash &&
          diffConfigPaths(currentSourceConfig, snapshot.sourceConfig).length === 0;
        // This hash comes from the startup write itself. Consume only its
        // first source-identical watcher echo; includes can change under it.
        startupInternalWriteHash = null;
        if (matchesStartupWrite) {
          await acceptCurrentRuntimeEcho(transactionEpoch, snapshot);
          return;
        }
      }
      if (
        intentCandidate &&
        snapshot.valid &&
        snapshot.hash === intentCandidate.persistedHash &&
        diffConfigPaths(intentCandidate.compareConfig, snapshot.sourceConfig).length === 0
      ) {
        lastAppliedWriteHash = intentCandidate.persistedHash;
        try {
          await runAcceptedTransaction(async () => {
            await applySnapshot(
              intentCandidate.config,
              intentCandidate.compareConfig,
              intentCandidate.afterWrite,
              transactionEpoch,
              intentCandidate.persistedHash,
              intentCandidate.preparedCandidate,
              intentCandidate.runtimeRefresh,
              snapshot.parsed,
            );
            if (watcherIntentCandidate === intentCandidate) {
              watcherIntentCandidate = null;
            }
            await promoteAcceptedSnapshot(snapshot, "in-process-write");
          });
        } catch (err) {
          if (lastAppliedWriteHash === intentCandidate.persistedHash) {
            lastAppliedWriteHash = null;
          }
          if (configWriteEpoch === transactionEpoch && !watcherIntentCandidate) {
            watcherIntentCandidate = intentCandidate;
          }
          throw err;
        }
        await acceptWatchedPaths(snapshot.includedPaths ?? []);
        return;
      }
      if (watcherIntentCandidate === intentCandidate) {
        watcherIntentCandidate = null;
      }
      if (intentCandidate && lastAppliedWriteHash === intentCandidate.persistedHash) {
        lastAppliedWriteHash = null;
      }
      if (lastAppliedWriteHash && typeof snapshot.hash === "string") {
        const matchesAcceptedEffectiveConfig =
          snapshot.valid &&
          snapshot.hash === lastAppliedWriteHash &&
          diffConfigPaths(currentSourceConfig, snapshot.sourceConfig).length === 0;
        if (matchesAcceptedEffectiveConfig) {
          if (snapshot.hash === lastSourceOnlyWriteHash) {
            const ownership: GatewayConfigReloadTransactionOwnership = {
              isCurrent: () => configWriteEpoch === transactionEpoch,
              reapplyRuntimeOverlays:
                lastSourceOnlyReapplyRuntimeOverlays ?? currentReapplyRuntimeOverlays,
              publishRuntimeEnv: () => {},
              rollbackRuntimeEnv: () => {},
              commitRuntimeEnv: () => {},
              ...(lastSourceOnlyRuntimeRefresh
                ? { runtimeRefresh: lastSourceOnlyRuntimeRefresh }
                : {}),
              markRuntimeCommitted: () => {},
            };
            await runAcceptedTransaction(async () => {
              await appliedRevision.flush(currentConfig);
              if (!ownership.isCurrent()) {
                throw new GatewayConfigReloadSupersededError();
              }
              await opts.onConfigAccepted?.(
                lastSourceOnlyRuntimeConfig ?? currentConfig,
                ownership,
                lastSourceOnlySourceConfig ?? currentSourceConfig,
                { runtimeApplied: false },
              );
              if (!ownership.isCurrent()) {
                throw new GatewayConfigReloadSupersededError();
              }
              if (typeof snapshot.hash === "string") {
                updateAcceptedSnapshot(snapshot.hash, snapshot.parsed);
              }
            });
            await acceptWatchedPaths(snapshot.includedPaths ?? []);
            return;
          }
          await acceptCurrentRuntimeEcho(transactionEpoch, snapshot);
          return;
        }
        lastAppliedWriteHash = null;
      }
      if (!snapshot.valid) {
        if (newObservedRawHash) {
          appendExternalAudit({
            detectedBy: "watch",
            previousHash: previousObservedRawHash,
            nextHash: observedRawHash,
            valid: false,
            issues: capConfigAuditIssues(
              formatConfigIssueLines(snapshot.issues, "", { normalizeRoot: true }),
            ),
          });
        }
        handleInvalidSnapshot(snapshot);
        await appliedRevision.flush(currentConfig);
        return;
      }
      const nextRawHash = snapshot.hash ?? null;
      const externalChangedPaths = diffConfigPaths(currentSourceConfig, snapshot.sourceConfig);
      const fingerprintedAuthoredChangedPaths = diffConfigPaths(
        currentFingerprintedAuthoredConfig,
        fingerprintConfigSnapshotAuthoredConfig(snapshot.parsed, { env: process.env, homedir }),
      );
      const journalChangedPaths = [
        ...new Set([...externalChangedPaths, ...fingerprintedAuthoredChangedPaths]),
      ];
      const matchingWriterSlot = readConfigSnapshotAuditRecord({ configPath: opts.watchPath });
      if (
        newObservedRawHash &&
        (nextRawHash === currentRawHash || matchingWriterSlot?.rawHash !== nextRawHash)
      ) {
        // Returning to accepted bytes after a rejected edit is still an observed transition.
        // A slot upsert can race awaitWriteFinish; the rare duplicate still carries exact hashes.
        appendExternalAudit({
          detectedBy: "watch",
          previousHash: previousObservedRawHash,
          nextHash: nextRawHash,
          valid: true,
          ...(journalChangedPaths.length > 0
            ? { changedPaths: capConfigAuditPaths(journalChangedPaths) }
            : {}),
          // No config-path diff means the raw edit was comments or formatting only.
          ...(journalChangedPaths.length === 0 ? { opaqueChange: true } : {}),
        });
      }
      await runAcceptedTransaction(async () => {
        await applySnapshot(
          snapshot.config,
          snapshot.sourceConfig,
          undefined,
          transactionEpoch,
          snapshot.hash,
          undefined,
          undefined,
          snapshot.parsed,
        );
        await promoteAcceptedSnapshot(snapshot, "valid-config");
      });
      await acceptWatchedPaths(snapshot.includedPaths ?? []);
    } catch (err) {
      if (isGatewayConfigReloadSupersededError(err)) {
        opts.log.info(`config reload superseded: ${String(err)}`);
      } else {
        opts.log.error(`config reload failed: ${String(err)}`);
      }
    } finally {
      running = false;
      if (pending) {
        pending = false;
        schedule();
      }
    }
  };

  function startTrackedReload(): void {
    const reload = runReload();
    activeReloads.add(reload);
    // A quick invocation can only set `pending` and finish while the owner run
    // remains active. Track every promise so it cannot replace that owner.
    void reload.then(
      () => activeReloads.delete(reload),
      () => activeReloads.delete(reload),
    );
  }

  const scheduleExternalRefresh = () => {
    opts.onConfigCandidateObserved?.();
    // Revoke the transaction synchronously. The debounced reread owns this new
    // epoch; a slow prior reload must not publish after a newer disk write.
    configWriteEpoch += 1;
    const pendingCandidate = pendingInProcessConfig;
    const activeCandidate = activeInProcessConfig;
    const newestLiveCandidate =
      pendingCandidate && (!activeCandidate || pendingCandidate.epoch > activeCandidate.epoch)
        ? pendingCandidate
        : activeCandidate;
    if (
      newestLiveCandidate &&
      (!watcherIntentCandidate || newestLiveCandidate.epoch > watcherIntentCandidate.epoch)
    ) {
      watcherIntentCandidate = newestLiveCandidate;
    }
    if (pendingInProcessConfig) {
      pendingInProcessConfig = null;
    }
    schedule();
  };

  const unsubscribeFromWrites =
    opts.subscribeToWrites?.((event) => {
      if (event.configPath !== opts.watchPath) {
        return;
      }
      // A live writer notification owns any following watcher echo. Do not
      // let the startup token discard its intent or prepared runtime metadata.
      startupInternalWriteHash = null;
      opts.onConfigCandidateObserved?.();
      configWriteEpoch += 1;
      watcherIntentCandidate = null;
      pendingInProcessConfig = {
        config: event.runtimeConfig,
        compareConfig: event.sourceConfig,
        persistedHash: event.persistedHash,
        afterWrite: event.afterWrite,
        ...(event.preparedCandidate ? { preparedCandidate: event.preparedCandidate } : {}),
        ...(event.runtimeRefresh ? { runtimeRefresh: event.runtimeRefresh } : {}),
        epoch: configWriteEpoch,
      };
      lastAppliedWriteHash = event.persistedHash;
      scheduleAfter(0);
    }) ?? (() => {});

  let watcher: ReturnType<typeof chokidar.watch> | null = null;
  const acceptedIncludedPaths = new Set(opts.initialIncludedPaths ?? []);
  let candidateIncludedPaths = new Set<string>();
  const watchedPaths = new Set([opts.watchPath, ...acceptedIncludedPaths]);
  let watcherRecreateRetries = 0;
  let watcherRecreateTimer: ReturnType<typeof setTimeout> | null = null;
  let hotReloadStatus: GatewayHotReloadStatus = "active";
  let degradedToPolling = false;
  let watcherUsesPolling = false;

  const createWatcher = (reconcileAfterReady = false) => {
    if (stopped) {
      return;
    }
    const usePolling = resolveChokidarUsePolling(degradedToPolling);
    const next = chokidar.watch([...watchedPaths], {
      depth: 0,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      usePolling,
    });
    // A file event proves this watcher recovered. Reset only here so plugin
    // metadata refreshes and consecutive watcher errors cannot refill the budget.
    const scheduleFromWatcherEvent = (eventPath: string) => {
      if (!watchedPaths.has(nodePath.normalize(eventPath))) {
        return;
      }
      watcherRecreateRetries = 0;
      scheduleExternalRefresh();
    };
    next.on("add", scheduleFromWatcherEvent);
    next.on("change", scheduleFromWatcherEvent);
    next.on("unlink", scheduleFromWatcherEvent);
    next.on("error", (err) => {
      handleWatcherError(next, err);
    });
    next.on("ready", () => {
      opts.onWatcherReady?.();
      if (reconcileAfterReady) {
        // Replacement watchers suppress their initial add event. Reconcile only after the
        // scan completes, and ignore a watcher that failed again before reaching ready.
        if (!stopped && watcher === next) {
          scheduleExternalRefresh();
        }
      }
    });
    watcher = next;
    watcherUsesPolling = next.options.usePolling;
    hotReloadStatus = "active";
  };

  const handleWatcherError = (source: typeof watcher, err: unknown) => {
    // Ignore stale errors from a watcher we already replaced or stopped.
    if (stopped || source !== watcher) {
      return;
    }
    const failedWatcherUsedPolling = watcherUsesPolling;
    watcher = null;
    watcherUsesPolling = false;
    void source?.close().catch(() => {});
    if (watcherRecreateRetries >= WATCHER_RECREATE_MAX_RETRIES) {
      // All native (inotify/kqueue) retries exhausted — fall back to polling
      // mode so config hot-reload survives on hosts where inotify resources
      // are constrained (e.g. low fs.inotify.max_user_watches).
      if (!failedWatcherUsedPolling && resolveChokidarUsePolling(true)) {
        degradedToPolling = true;
        watcherRecreateRetries = 0;
        opts.log.warn(
          `config watcher native retries exhausted; degrading to polling mode: ${String(err)}`,
        );
        watcherRecreateTimer = setTimeout(() => {
          watcherRecreateTimer = null;
          createWatcher(true);
        }, WATCHER_RECREATE_BACKOFF_MS[0] ?? 500);
        return;
      }
      const mode = failedWatcherUsedPolling ? "polling mode" : "native mode";
      hotReloadStatus = "disabled";
      opts.log.error(
        `config hot-reload disabled: watcher failed after ${WATCHER_RECREATE_MAX_RETRIES} re-create attempts in ${mode}: ${String(err)}`,
      );
      return;
    }
    const backoff =
      WATCHER_RECREATE_BACKOFF_MS[watcherRecreateRetries] ??
      WATCHER_RECREATE_BACKOFF_MS[WATCHER_RECREATE_BACKOFF_MS.length - 1] ??
      0;
    watcherRecreateRetries += 1;
    opts.log.warn(
      `config watcher error; re-creating watcher (attempt ${watcherRecreateRetries}/${WATCHER_RECREATE_MAX_RETRIES} in ${backoff}ms): ${String(err)}`,
    );
    watcherRecreateTimer = setTimeout(() => {
      watcherRecreateTimer = null;
      createWatcher(true);
    }, backoff);
  };

  const reconcileWatchedPaths = async (includedPaths: readonly string[]) => {
    const nextPaths = new Set([opts.watchPath, ...includedPaths]);
    const additions = [...nextPaths].filter((candidate) => !watchedPaths.has(candidate));
    const removals = [...watchedPaths].filter((candidate) => !nextPaths.has(candidate));
    if (additions.length === 0 && removals.length === 0) {
      return;
    }

    watchedPaths.clear();
    for (const candidate of nextPaths) {
      watchedPaths.add(candidate);
    }
    const activeWatcher = watcher;
    if (!activeWatcher) {
      return;
    }
    try {
      await activeWatcher.close();
    } catch (err) {
      handleWatcherError(activeWatcher, err);
      return;
    }
    if (stopped || watcher !== activeWatcher) {
      return;
    }
    watcher = null;
    watcherUsesPolling = false;
    createWatcher(true);
  };

  const observeCandidateWatchedPaths = async (includedPaths: readonly string[]) => {
    candidateIncludedPaths = new Set(includedPaths);
    await reconcileWatchedPaths([...acceptedIncludedPaths, ...candidateIncludedPaths]);
  };

  const acceptWatchedPaths = async (includedPaths: readonly string[]) => {
    acceptedIncludedPaths.clear();
    for (const candidate of includedPaths) {
      acceptedIncludedPaths.add(candidate);
    }
    candidateIncludedPaths.clear();
    await reconcileWatchedPaths([...acceptedIncludedPaths]);
  };

  createWatcher();

  return {
    notifyPluginMetadataChanged: () => {
      // The signal carries a metadata change while config bytes stay identical.
      // Clear both metadata and config-echo caches before scheduling the shared diff path.
      clearLoadInstalledPluginIndexInstallRecordsCache();
      startupInternalWriteHash = null;
      lastAppliedWriteHash = null;
      scheduleExternalRefresh();
    },
    stop: async () => {
      stopped = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = null;
      if (watcherRecreateTimer) {
        clearTimeout(watcherRecreateTimer);
        watcherRecreateTimer = null;
      }
      unsubscribeFromWrites();
      const active = watcher;
      watcher = null;
      await active?.close().catch(() => {});
      // Timer callbacks detach runReload; shutdown owns their full transaction unwind.
      await Promise.all(activeReloads);
    },
    hotReloadStatus: () => hotReloadStatus,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
