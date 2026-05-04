import chokidar from "chokidar";
import { bumpSkillsSnapshotVersion } from "../agents/skills/refresh-state.js";
import type { ConfigWriteNotification } from "../config/io.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import { resolveConfigWriteFollowUp } from "../config/runtime-snapshot.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  loadInstalledPluginIndexInstallRecords,
  loadInstalledPluginIndexInstallRecordsSync,
} from "../plugins/installed-plugin-index-records.js";
import { diffConfigPaths } from "./config-diff.js";
import {
  buildGatewayReloadPlan,
  listPluginInstallTimestampMetadataPaths,
  listPluginInstallWholeRecordPaths,
  type GatewayReloadPlan,
} from "./config-reload-plan.js";
import { resolveGatewayReloadSettings } from "./config-reload-settings.js";

export {
  buildGatewayReloadPlan,
  diffConfigPaths,
  listPluginInstallTimestampMetadataPaths,
  listPluginInstallWholeRecordPaths,
  resolveGatewayReloadSettings,
};
export type { ChannelKind, GatewayReloadPlan } from "./config-reload-plan.js";
const MISSING_CONFIG_RETRY_DELAY_MS = 150;
const MISSING_CONFIG_MAX_RETRIES = 2;

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

export function shouldInvalidateSkillsSnapshotForPaths(changedPaths: string[]): boolean {
  return firstSkillsChangedPath(changedPaths) !== undefined;
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
  onHotReload: (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => Promise<void>;
  onRestart: (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => void | Promise<void>;
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
  const queueRestart = (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => {
    if (restartQueued) {
      return;
    }
    restartQueued = true;
    void (async () => {
      try {
        await opts.onRestart(plan, nextConfig);
      } catch (err) {
        // Restart checks can fail (for example unresolved SecretRefs). Keep the
        // reloader alive and allow a future change to retry restart scheduling.
        restartQueued = false;
        opts.log.error(`config restart failed: ${String(err)}`);
      }
    })();
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
    if (isNoopReloadPlan(plan) && !followUp.requiresRestart) {
      return;
    }
    if (settings.mode === "off") {
      opts.log.info("config reload disabled (gateway.reload.mode=off)");
      return;
    }
    if (followUp.requiresRestart) {
      queueRestart(
        {
          ...plan,
          restartGateway: true,
          restartReasons: [...plan.restartReasons, followUp.reason],
        },
        nextConfig,
      );
      return;
    }
    if (settings.mode === "restart") {
      queueRestart(plan, nextConfig);
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
      queueRestart(plan, nextConfig);
      return;
    }

    await opts.onHotReload(plan, nextConfig);
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
        await applySnapshot(
          pendingWrite.config,
          pendingWrite.compareConfig,
          pendingWrite.afterWrite,
        );
        await promoteAcceptedInProcessWrite(pendingWrite.persistedHash);
        return;
      }
      let snapshot = await opts.readSnapshot();
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
      await applySnapshot(snapshot.config, snapshot.sourceConfig);
      await promoteAcceptedSnapshot(snapshot, "valid-config");
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

  const watcher = chokidar.watch(opts.watchPath, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    usePolling: Boolean(process.env.VITEST),
  });

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

  watcher.on("add", scheduleFromWatcher);
  watcher.on("change", scheduleFromWatcher);
  watcher.on("unlink", scheduleFromWatcher);
  let watcherClosed = false;
  watcher.on("error", (err) => {
    if (watcherClosed) {
      return;
    }
    watcherClosed = true;
    opts.log.warn(`config watcher error: ${String(err)}`);
    void watcher.close().catch(() => {});
  });

  return {
    stop: async () => {
      stopped = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = null;
      watcherClosed = true;
      unsubscribeFromWrites();
      await watcher.close().catch(() => {});
    },
  };
}
