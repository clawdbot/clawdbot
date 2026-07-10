// Gateway config hot-reload watcher.
// Diffs config/plugin install snapshots and dispatches hot reload or restart plans.
import chokidar from "chokidar";
import type { ConfigWriteNotification } from "../config/io.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import { resolveConfigWriteFollowUp } from "../config/runtime-snapshot.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  loadInstalledPluginIndexInstallRecords,
  loadInstalledPluginIndexInstallRecordsSync,
} from "../plugins/installed-plugin-index-records.js";
import { bumpSkillsSnapshotVersion } from "../skills/runtime/refresh-state.js";
import { diffConfigPaths } from "./config-diff.js";
import {
  buildGatewayReloadPlan,
  listPluginInstallTimestampMetadataPaths,
  listPluginInstallWholeRecordPaths,
  resolveConfigReloadMetadata,
  type GatewayReloadPlan,
} from "./config-reload-plan.js";
import { resolveGatewayReloadSettings } from "./config-reload-settings.js";
import type { GatewayHotReloadStatus } from "./config-reload-status.types.js";

export {
  buildGatewayReloadPlan,
  diffConfigPaths,
  listPluginInstallTimestampMetadataPaths,
  listPluginInstallWholeRecordPaths,
  resolveConfigReloadMetadata,
  resolveGatewayReloadSettings,
};
export type { ChannelKind, GatewayReloadPlan } from "./config-reload-plan.js";
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
    plan.restartChannels.size === 0
  );
}

type GatewayConfigReloader = {
  stop: () => Promise<void>;
  hotReloadStatus: () => GatewayHotReloadStatus;
};

type PluginInstallRecords = Record<string, PluginInstallRecord>;

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
  initialInternalWriteHash?: string | null;
  readSnapshot: () => Promise<ConfigFileSnapshot>;
  onConfigChange?: (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => void | Promise<void>;
  onConfigApplied?: (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => void | Promise<void>;
  onNoopConfigCommit: (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => Promise<void>;
  onHotReload: (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => Promise<void>;
  onRestart: (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => void | Promise<void>;
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
  let currentConfig = opts.initialConfig;
  let currentCompareConfig = opts.initialCompareConfig ?? opts.initialConfig;
  let settings = resolveGatewayReloadSettings(currentConfig);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  let running = false;
  let stopped = false;
  let restartQueued = false;
  let missingConfigRetries = 0;
  let pendingInProcessConfig: {
    config: OpenClawConfig;
    compareConfig: OpenClawConfig;
    persistedHash: string;
    afterWrite?: ConfigWriteNotification["afterWrite"];
  } | null = null;
  let lastAppliedWriteHash = opts.initialInternalWriteHash ?? null;
  let currentPluginInstallRecords =
    opts.initialPluginInstallRecords ?? loadInstalledPluginIndexInstallRecordsSync();
  const readPluginInstallRecords =
    opts.readPluginInstallRecords ?? loadInstalledPluginIndexInstallRecords;

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
      void runReload();
    }, wait);
  };
  const schedule = () => {
    scheduleAfter(settings.debounceMs);
  };
  const queueRestart = async (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => {
    if (restartQueued) {
      return;
    }
    restartQueued = true;
    try {
      // Restart preparation reads secrets and can mutate auth/runtime state.
      // Keep it inside the accepted config transaction instead of detaching it.
      await opts.onRestart(plan, nextConfig);
    } catch (err) {
      // Restart checks can fail (for example unresolved SecretRefs). Keep the
      // reloader alive and allow a future change to retry restart scheduling.
      restartQueued = false;
      opts.log.error(`config restart failed: ${String(err)}`);
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
    nextConfig: OpenClawConfig,
    nextCompareConfig: OpenClawConfig,
    afterWrite?: ConfigWriteNotification["afterWrite"],
  ) => {
    const configChangedPaths = diffConfigPaths(currentCompareConfig, nextCompareConfig);
    const configPluginInstallTimestampNoopPaths = listPluginInstallTimestampMetadataPaths(
      currentCompareConfig,
      nextCompareConfig,
    );
    const configPluginInstallWholeRecordPaths = listPluginInstallWholeRecordPaths(
      currentCompareConfig,
      nextCompareConfig,
    );
    let nextPluginInstallRecords = currentPluginInstallRecords;
    try {
      nextPluginInstallRecords = await readPluginInstallRecords();
    } catch (err) {
      opts.log.warn(`config reload plugin install record check failed: ${String(err)}`);
    }
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
    currentConfig = nextConfig;
    currentCompareConfig = nextCompareConfig;
    currentPluginInstallRecords = nextPluginInstallRecords;
    settings = resolveGatewayReloadSettings(nextConfig);
    if (changedPaths.length === 0) {
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
      return;
    }
    const plan = buildGatewayReloadPlan(changedPaths, {
      noopPaths: pluginInstallTimestampNoopPaths,
      forceChangedPaths: pluginInstallWholeRecordPaths,
    });
    if (settings.mode === "off") {
      opts.log.info("config reload disabled (gateway.reload.mode=off)");
      return;
    }
    if (isNoopReloadPlan(plan) && !followUp.requiresRestart) {
      await opts.onConfigChange?.(plan, nextConfig);
      // No-op plans still change the runtime config snapshot. Commit before
      // marking applied so getRuntimeConfig() readers do not stay stale until restart.
      await opts.onNoopConfigCommit(plan, nextConfig);
      await opts.onConfigApplied?.(plan, nextConfig);
      return;
    }
    if (followUp.requiresRestart) {
      const restartPlan = {
        ...plan,
        restartGateway: true,
        restartReasons: [...plan.restartReasons, followUp.reason],
      };
      await opts.onConfigChange?.(restartPlan, nextConfig);
      await queueRestart(restartPlan, nextConfig);
      return;
    }
    if (settings.mode === "restart") {
      await opts.onConfigChange?.({ ...plan, restartGateway: true }, nextConfig);
      await queueRestart(plan, nextConfig);
      return;
    }
    if (plan.restartGateway) {
      if (settings.mode === "hot") {
        opts.log.warn(
          `config reload requires gateway restart; hot mode ignoring (${plan.restartReasons.join(
            ", ",
          )})`,
        );
        return;
      }
      await opts.onConfigChange?.(plan, nextConfig);
      await queueRestart(plan, nextConfig);
      return;
    }

    await opts.onConfigChange?.(plan, nextConfig);
    await opts.onHotReload(plan, nextConfig);
    await opts.onConfigApplied?.(plan, nextConfig);
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

  const promoteAcceptedInProcessWrite = async (persistedHash: string) => {
    if (!opts.promoteSnapshot) {
      return;
    }
    try {
      const snapshot = await opts.readSnapshot();
      if (snapshot.hash !== persistedHash || !snapshot.valid) {
        return;
      }
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
        missingConfigRetries = 0;
        await runAcceptedTransaction(async () => {
          await applySnapshot(
            pendingWrite.config,
            pendingWrite.compareConfig,
            pendingWrite.afterWrite,
          );
          await promoteAcceptedInProcessWrite(pendingWrite.persistedHash);
        });
        return;
      }
      const snapshot = await opts.readSnapshot();
      if (lastAppliedWriteHash && typeof snapshot.hash === "string") {
        if (snapshot.hash === lastAppliedWriteHash) {
          return;
        }
        lastAppliedWriteHash = null;
      }
      if (handleMissingSnapshot(snapshot)) {
        return;
      }
      if (!snapshot.valid) {
        handleInvalidSnapshot(snapshot);
        return;
      }
      await runAcceptedTransaction(async () => {
        await applySnapshot(snapshot.config, snapshot.sourceConfig);
        await promoteAcceptedSnapshot(snapshot, "valid-config");
      });
    } catch (err) {
      opts.log.error(`config reload failed: ${String(err)}`);
    } finally {
      running = false;
      if (pending) {
        pending = false;
        schedule();
      }
    }
  };

  const scheduleFromWatcher = () => {
    schedule();
  };

  const unsubscribeFromWrites =
    opts.subscribeToWrites?.((event) => {
      if (event.configPath !== opts.watchPath) {
        return;
      }
      pendingInProcessConfig = {
        config: event.runtimeConfig,
        compareConfig: event.sourceConfig,
        persistedHash: event.persistedHash,
        afterWrite: event.afterWrite,
      };
      lastAppliedWriteHash = event.persistedHash;
      scheduleAfter(0);
    }) ?? (() => {});

  let watcher: ReturnType<typeof chokidar.watch> | null = null;
  let watcherRecreateRetries = 0;
  let watcherRecreateTimer: ReturnType<typeof setTimeout> | null = null;
  let hotReloadStatus: GatewayHotReloadStatus = "active";
  let degradedToPolling = false;
  let watcherUsesPolling = false;

  const createWatcher = () => {
    if (stopped) {
      return;
    }
    const usePolling = resolveChokidarUsePolling(degradedToPolling);
    const next = chokidar.watch(opts.watchPath, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      usePolling,
    });
    next.on("add", scheduleFromWatcher);
    next.on("change", scheduleFromWatcher);
    next.on("unlink", scheduleFromWatcher);
    next.on("error", (err) => {
      handleWatcherError(next, err);
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
          createWatcher();
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
      createWatcher();
    }, backoff);
  };

  createWatcher();

  return {
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
    },
    hotReloadStatus: () => hotReloadStatus,
  };
}
