import { homedir } from "node:os";
import nodePath from "node:path";
// Gateway config hot-reload watcher.
// Diffs config/plugin install snapshots and dispatches hot reload or restart plans.
import chokidar from "chokidar";
import { listAgentWorkspaceDirs } from "../agents/workspace-dirs.js";
import { collectChannelSchemaMetadataWithOwnership } from "../config/channel-config-metadata.js";
import { createConfiguredChannelOwnershipPolicy } from "../config/channel-ownership-policy.js";
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
import { resolveConfigWidePluginManifestRegistry } from "../config/io.plugin-metadata.js";
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
import { collectCededChannelIdsByPlugin } from "../plugins/loader-shared.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { bumpSkillsSnapshotVersion } from "../skills/runtime/refresh-state.js";
import { createConfigAppliedRevisionTracker } from "./config-applied-revision.js";
import { diffConfigPaths, diffGatewayReloadPaths } from "./config-diff.js";
import {
  buildGatewayReloadPlan,
  isNoopGatewayReloadPlan,
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

/**
 * The channel owner each side of a config transaction selects, keyed by canonical channel id, on
 * both planes the codebase distinguishes: the schema owner is computed with the same registry and
 * ownership policy the schema plane uses (`loadGatewayRuntimeConfigSchema` pairs them the same
 * way), and the runtime cede owner comes from the collector plugin registration shares, so the
 * reload path cannot judge ownership by a different rule than validation, the Control UI, or the
 * loader apply.
 *
 * The pairing matters: ownership reads explicit selection and the per-channel activation
 * candidates from the SOURCE config, because auto-enable materializes
 * `plugins.entries.<id>.enabled` into the runtime config and a materialized-config read would
 * report every auto-enabled claimant as hand-picked. The runtime config still supplies policy
 * disablement and the registry workspace roots, mirroring how the schema endpoint pairs
 * `getRuntimeConfig()` with the published source snapshot.
 */
type ChannelOwnersSnapshot = {
  /** Selected schema owner per channel; undefined when no claimant ships a descriptor. */
  schemaOwners: Map<string, string | undefined>;
  /** Runtime cede owner per contested channel: the claimant registration hands the channel to. */
  runtimeOwners: Map<string, string>;
};

function collectChannelOwners(side: {
  config: OpenClawConfig;
  sourceConfig: OpenClawConfig;
}): ChannelOwnersSnapshot {
  const registry = resolveConfigWidePluginManifestRegistry({
    config: side.config,
    env: process.env,
  });
  const policy = createConfiguredChannelOwnershipPolicy({
    config: side.config,
    sourceConfig: side.sourceConfig,
    registry,
    env: process.env,
  });
  const schemaOwners = new Map<string, string | undefined>();
  for (const entry of collectChannelSchemaMetadataWithOwnership(registry, policy)) {
    schemaOwners.set(entry.id, entry.schemaPluginId);
  }
  // A contest can exist with no schema descriptor on any side: a bare `record.channels` claim
  // serves a channel, and a `preferOver` declaration can travel on `channelCatalogMeta` alone,
  // which auto-enable honors like a `channelConfigs` one. The schema map reports no owner for
  // such a channel however ownership settles, so the runtime plane's cede owner — the same
  // shared rule plugin registration applies — travels alongside it, or a hot edit could still
  // restart the stale owner while activation would select the replacement. The two planes stay
  // in separate maps because manifest channel ids are arbitrary strings, so no composite key
  // can be proven collision-free.
  const { cededChannelOwners } = collectCededChannelIdsByPlugin({
    registry,
    config: side.config,
    sourceConfig: side.sourceConfig,
    env: process.env,
    onlyPluginIdSet: null,
    dreamingSidecar: null,
  });
  return { schemaOwners, runtimeOwners: cededChannelOwners };
}

type ChannelOwnershipChange = {
  channelId: string;
  previousOwner: string | undefined;
  nextOwner: string | undefined;
};

/** The first channel whose selected owner differs between the two config pairs, on either plane. */
function findChannelOwnershipChange(params: {
  previous: { config: OpenClawConfig; sourceConfig: OpenClawConfig };
  next: { config: OpenClawConfig; sourceConfig: OpenClawConfig };
}): ChannelOwnershipChange | null {
  const previous = collectChannelOwners(params.previous);
  const next = collectChannelOwners(params.next);
  const planes: ReadonlyArray<
    [ReadonlyMap<string, string | undefined>, ReadonlyMap<string, string | undefined>]
  > = [
    [previous.schemaOwners, next.schemaOwners],
    [previous.runtimeOwners, next.runtimeOwners],
  ];
  for (const [previousOwners, nextOwners] of planes) {
    for (const channelId of new Set([...previousOwners.keys(), ...nextOwners.keys()])) {
      const previousOwner = previousOwners.get(channelId);
      const nextOwner = nextOwners.get(channelId);
      if (previousOwner !== nextOwner) {
        return { channelId, previousOwner, nextOwner };
      }
    }
  }
  return null;
}

/**
 * Whether an authored edit touched anything channel ownership SELECTION reads. Selection resolves
 * from explicit plugin selection and the per-channel activation candidates, both of which live
 * under `plugins` or `channels` in the source config. Ownership can still move without either
 * when an `agents.*` edit changes the workspace roots plugin discovery scans; the
 * `agentWorkspaceRootsMoved` trigger below owns that case.
 *
 * Both ownership-comparison triggers gate on it — the zero-diff guard (`noDiffOwnershipChange`)
 * and the hot-edit escalation gate below it — to keep the comparison off ordinary reload paths:
 * resolving a manifest registry and walking ownership on both sides costs a few milliseconds warm
 * and far more when no process-current plugin metadata snapshot is published, while
 * `diffConfigPaths` is the same walk this file already runs on other source-only paths.
 */
function sourceEditTouchesChannelOwnership(
  previousSourceConfig: OpenClawConfig,
  nextSourceConfig: OpenClawConfig,
): boolean {
  return diffConfigPaths(previousSourceConfig, nextSourceConfig).some(
    (path) =>
      path === "plugins" ||
      path === "channels" ||
      path.startsWith("plugins.") ||
      path.startsWith("channels."),
  );
}

/**
 * Whether the agent workspace roots the config-wide manifest registry discovers from moved.
 * `resolveConfigWidePluginManifestRegistry` discovers plugin manifests per workspace dir, so an
 * `agents.*` edit that moves, adds, removes, or reorders a workspace changes which claimants exist
 * at all — no `plugins.*` or `channels.*` path has to change for ownership to move. Order counts:
 * registry merge order carries origin precedence for channel schema ownership. The roots resolve
 * from the runtime config pair because that is the pair the ownership comparison hands the
 * registry resolver.
 */
function agentWorkspaceRootsMoved(
  previousConfig: OpenClawConfig,
  nextConfig: OpenClawConfig,
): boolean {
  try {
    const previousDirs = listAgentWorkspaceDirs(previousConfig);
    const nextDirs = listAgentWorkspaceDirs(nextConfig);
    return (
      previousDirs.length !== nextDirs.length ||
      previousDirs.some((dir, index) => dir !== nextDirs[index])
    );
  } catch {
    // An unresolvable roster proves nothing about the roots; let the ownership comparison decide.
    return true;
  }
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
  /**
   * Fires when the watcher observes a persisted config it cannot accept — an
   * invalid file, or one missing after retries. No snapshot is published on
   * these paths, so file-derived response caches (config.get) must drop their
   * entries or CAS writers retry against a hash the file no longer has.
   */
  onConfigCandidateRejected?: () => void;
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
  // Signaled metadata changes clear the process snapshot slot before the diff
  // pass runs; the counters keep that pass honest when config bytes are
  // unchanged, and stay pending until a plugin reload or restart commits.
  let pluginMetadataRefreshRequests = 0;
  let pluginMetadataRefreshApplied = 0;
  let pendingInProcessConfig: InProcessConfigCandidate | null = null;
  let activeInProcessConfig: InProcessConfigCandidate | null = null;
  let watcherIntentCandidate: InProcessConfigCandidate | null = null;
  let watcherIntentCameFromPendingWrite = false;
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
    // Only the settled state invalidates: a mid-write rename gap heals within the retries above.
    opts.onConfigCandidateRejected?.();
    return true;
  };

  const handleInvalidSnapshot = (snapshot: ConfigFileSnapshot): boolean => {
    if (snapshot.valid) {
      return false;
    }
    const issues = formatConfigIssueLines(snapshot.issues, "").join(", ");
    opts.log.warn(`config reload skipped (invalid config): ${issues}`);
    opts.onConfigCandidateRejected?.();
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
    // A signaled metadata change emptied the process snapshot slot. An
    // unchanged config diff must still replace the plugin runtime generation so
    // the slot republishes instead of leaving configless readers cold-scanning
    // against a registry that diverged from the live runtime owners.
    const pluginMetadataRefreshToken = pluginMetadataRefreshRequests;
    const forcePluginMetadataReload = pluginMetadataRefreshToken !== pluginMetadataRefreshApplied;
    const markPluginMetadataRefreshApplied = () => {
      pluginMetadataRefreshApplied = pluginMetadataRefreshToken;
    };
    // An authored edit can move a channel's selected owner while auto-enable leaves the effective
    // config byte-identical: explicitly selecting a fallback that auto-enable had already
    // materialized for another channel changes `isPluginExplicitlySelected` in the source while
    // every effective path stays put. The early return below still publishes the source snapshot,
    // so validation and the Control UI switch to the newly selected owner while the active registry
    // keeps the previous `cededChannelIds` and goes on serving the replacement. Bypass the early
    // return when that happens, exactly as a forced plugin-metadata refresh already does.
    //
    // The source-diff guard runs first so an ordinary no-op reload never pays for the comparison,
    // and a resolution failure escalates rather than being read as "ownership held still".
    const noDiffOwnershipChange = ((): ChannelOwnershipChange | null => {
      if (changedPaths.length > 0 || forcePluginMetadataReload) {
        return null;
      }
      try {
        if (!sourceEditTouchesChannelOwnership(currentRuntimeEnvSourceConfig, nextSourceConfig)) {
          return null;
        }
        return findChannelOwnershipChange({
          previous: { config: currentConfig, sourceConfig: currentRuntimeEnvSourceConfig },
          next: { config: nextConfig, sourceConfig: nextSourceConfig },
        });
      } catch (err) {
        opts.log.warn(
          `channel ownership comparison failed on an unchanged effective config: ${String(err)}`,
        );
        return { channelId: "unknown", previousOwner: undefined, nextOwner: undefined };
      }
    })();
    if (changedPaths.length === 0 && !forcePluginMetadataReload && !noDiffOwnershipChange) {
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
    opts.log.info(
      changedPaths.length > 0
        ? `config change detected; evaluating reload (${changedPaths.join(", ")})`
        : "plugin metadata changed with identical config; replacing plugin runtime generation",
    );
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
    if (forcePluginMetadataReload && !plan.restartGateway && !plan.reloadPlugins) {
      // Mirror the `plugins.*` hot rule pairing: a replaced plugin registry
      // also invalidates MCP runtimes assembled from the previous generation.
      plan.reloadPlugins = true;
      plan.disposeMcpRuntimes = true;
    }
    if (noDiffOwnershipChange && !plan.restartGateway && !plan.reloadPlugins) {
      opts.log.info(
        `channel ownership moved without an effective config change (${
          noDiffOwnershipChange.channelId
        }: ${noDiffOwnershipChange.previousOwner ?? "none"} -> ${
          noDiffOwnershipChange.nextOwner ?? "none"
        }); reloading plugins`,
      );
      plan.reloadPlugins = true;
      plan.disposeMcpRuntimes = true;
    }
    // A moved workspace root changes plugin discovery itself, so it can move ownership past the
    // source-path predicate below, and it can also invalidate an already-planned plugin reload:
    // `reloadAttachedGatewayPlugins` rebuilds the lookup table and metadata snapshot from the
    // process-stable startup `pluginWorkspaceDir`, so only a gateway restart re-resolves
    // discovery from the new roots. That is why the moved-roots trigger bypasses the
    // `!plan.reloadPlugins` guard and why its escalation below restarts instead of reloading.
    const workspaceRootsMoved = agentWorkspaceRootsMoved(currentConfig, nextConfig);
    if (
      // Under reload-off the transaction commits the baseline without acting on the plan
      // (`commitReloadBaseline({runtimeApplied:false})` below never reads it), so the comparison
      // could only burn the registry resolution and log a plugin reload that never happens.
      // The mode gate below owns the outcome either way; skipping here changes no behavior.
      nextSettings.mode !== "off" &&
      !plan.restartGateway &&
      // Moved roots outrank an already-planned plugin reload (the reload rebuilds from the
      // startup roots); the remaining arms keep the `!plan.reloadPlugins` guard because the
      // moves they catch are ones a planned reload already rebuilds and restarts itself.
      (workspaceRootsMoved ||
        (!plan.reloadPlugins &&
          (plan.restartChannels.size > 0 ||
            (plan.restartChannelAccounts?.size ?? 0) > 0 ||
            sourceEditTouchesChannelOwnership(currentRuntimeEnvSourceConfig, nextSourceConfig))))
    ) {
      // A `channels.<id>` edit can move the channel's selected owner without touching any
      // `plugins.*` path: ownership reads the per-channel activation candidates from the source
      // config, so making or unmaking the channel configured narrows the claimant set. The plan
      // above only restarts the channel, and `startGatewayChannelFromActiveRegistry` starts it
      // from the previous plugin registry, so validation and the Control UI would describe the
      // replacement while the Gateway restarts the displaced owner. Rebuild the plugin registry
      // first when an owner actually moved — an ownership-neutral channel edit keeps its cheap
      // plan — with the same MCP runtime pairing as the metadata escalation above.
      //
      // The trigger reads the source edit, not the plan: a channel plugin's reload metadata may
      // classify a `channels.<id>` path as a no-op (WhatsApp's broad noop prefix), and such an
      // edit can still make the channel meaningfully configured and move the owner while
      // `plan.restartChannels` stays empty. The comparison below still decides the escalation,
      // so a neutral edit pays only the diff walk this transaction already runs elsewhere.
      try {
        // The previous side must pair `currentConfig` with `currentRuntimeEnvSourceConfig`, not
        // `currentSourceConfig`: a source-only commit (reload mode off, writer intent "none")
        // advances the source baseline without advancing the runtime config or the active plugin
        // registry. After such a commit the plain source baseline already selects the replacement
        // owner, so pairing it with the stale runtime config reports the move on both sides and
        // hides the escalation while the channel restarts from the stale registry. The
        // runtime-env source baseline advances only when the runtime config does, so it is the
        // source config the active registry was actually built from.
        const ownershipChange = findChannelOwnershipChange({
          previous: { config: currentConfig, sourceConfig: currentRuntimeEnvSourceConfig },
          next: { config: nextConfig, sourceConfig: nextSourceConfig },
        });
        if (ownershipChange && workspaceRootsMoved) {
          // A plugin reload cannot honor the new roots (startup `pluginWorkspaceDir` above), so
          // escalating to it would rebuild the registry from the old workspace and report success
          // while validation keeps describing the new one. Restart re-resolves discovery.
          const reason = `channel ownership moved with an agent workspace root (${
            ownershipChange.channelId
          }: ${ownershipChange.previousOwner ?? "none"} -> ${ownershipChange.nextOwner ?? "none"})`;
          opts.log.info(`${reason}; restarting gateway`);
          plan.restartGateway = true;
          plan.restartReasons.push(reason);
        } else if (ownershipChange) {
          // No "before channel restart": on the widened trigger the plan may restart no channel
          // at all — the reload result itself restarts owner-changed channels
          // (`pluginReloadResult.restartChannels` in `server-reload-hot.ts`).
          opts.log.info(
            `channel ownership moved (${ownershipChange.channelId}: ${
              ownershipChange.previousOwner ?? "none"
            } -> ${ownershipChange.nextOwner ?? "none"}); reloading plugins`,
          );
          plan.reloadPlugins = true;
          plan.disposeMcpRuntimes = true;
        }
      } catch (err) {
        // A metadata resolution failure is no proof ownership held still. Escalate to the plugin
        // reload, whose lifecycle recovery owns metadata failures — or to the restart when moved
        // roots make the reload unable to rebuild what this transaction could not compare.
        opts.log.warn(`channel ownership comparison failed: ${String(err)}`);
        if (workspaceRootsMoved) {
          plan.restartGateway = true;
          plan.restartReasons.push(
            "channel ownership comparison failed with moved agent workspace roots",
          );
        } else {
          plan.reloadPlugins = true;
          plan.disposeMcpRuntimes = true;
        }
      }
    }
    if (nextSettings.mode === "off") {
      opts.log.info("config reload disabled (gateway.reload.mode=off)");
      await commitReloadBaseline({ runtimeApplied: false });
      return;
    }
    if (isNoopGatewayReloadPlan(plan) && !followUp.requiresRestart) {
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
      // The accepted restart owns snapshot republication at next startup.
      markPluginMetadataRefreshApplied();
      return;
    }
    if (plan.restartGateway) {
      await opts.onConfigChange?.(plan, nextConfig);
      await prepareRestart(plan, nextConfig, ownership, nextSourceConfig);
      await commitReloadBaseline();
      markPluginMetadataRefreshApplied();
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
    if (plan.reloadPlugins) {
      // The committed reload republished the metadata snapshot generation.
      markPluginMetadataRefreshApplied();
    }
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
            watcherIntentCameFromPendingWrite = false;
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
      const intentCandidateCameFromPendingWrite = watcherIntentCameFromPendingWrite;
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
              watcherIntentCameFromPendingWrite = false;
            }
            await promoteAcceptedSnapshot(snapshot, "in-process-write");
          });
        } catch (err) {
          if (lastAppliedWriteHash === intentCandidate.persistedHash) {
            lastAppliedWriteHash = null;
          }
          if (configWriteEpoch === transactionEpoch && !watcherIntentCandidate) {
            watcherIntentCandidate = intentCandidate;
            watcherIntentCameFromPendingWrite = intentCandidateCameFromPendingWrite;
          }
          throw err;
        }
        await acceptWatchedPaths(snapshot.includedPaths ?? []);
        return;
      }
      if (watcherIntentCandidate === intentCandidate) {
        watcherIntentCandidate = null;
        watcherIntentCameFromPendingWrite = false;
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
      watcherIntentCameFromPendingWrite = newestLiveCandidate === pendingCandidate;
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
      const pendingRestartIntent =
        pendingInProcessConfig?.afterWrite?.mode === "restart"
          ? pendingInProcessConfig.afterWrite
          : watcherIntentCameFromPendingWrite &&
              watcherIntentCandidate?.afterWrite?.mode === "restart"
            ? watcherIntentCandidate.afterWrite
            : undefined;
      watcherIntentCandidate = null;
      watcherIntentCameFromPendingWrite = false;
      // Pending writes coalesce to the latest config, but a newer non-restart intent
      // must not erase a restart already required by an unapplied committed write,
      // including one moved into watcher ownership by its filesystem echo.
      const afterWrite =
        pendingRestartIntent && event.afterWrite?.mode !== "restart"
          ? pendingRestartIntent
          : event.afterWrite;
      pendingInProcessConfig = {
        config: event.runtimeConfig,
        compareConfig: event.sourceConfig,
        persistedHash: event.persistedHash,
        afterWrite,
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
      pluginMetadataRefreshRequests += 1;
      clearLoadInstalledPluginIndexInstallRecordsCache();
      clearPluginMetadataLifecycleCaches();
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
