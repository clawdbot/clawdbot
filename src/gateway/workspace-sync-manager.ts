/**
 * Background workspace sync manager for the gateway.
 *
 * Runs rclone bisync at configured intervals WITHOUT involving the agent/LLM.
 * This is a pure file operation that incurs zero token cost.
 */

import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { MoltbotConfig } from "../config/config.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  isRcloneInstalled,
  isRcloneConfigured,
  ensureRcloneConfigFromConfig,
  resolveSyncConfig,
  runBisync,
} from "../infra/rclone.js";

type SyncManagerLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

type SyncManagerState = {
  intervalId: ReturnType<typeof setInterval> | null;
  lastSyncAt: Date | null;
  lastSyncOk: boolean | null;
  syncCount: number;
  errorCount: number;
  hasSuccessfulSync: boolean;
  syncInProgress: boolean;
};

const state: SyncManagerState = {
  intervalId: null,
  lastSyncAt: null,
  lastSyncOk: null,
  syncCount: 0,
  errorCount: 0,
  hasSuccessfulSync: false,
  syncInProgress: false,
};

let currentConfig: MoltbotConfig | null = null;
let currentLogger: SyncManagerLogger | null = null;

/**
 * Run a single sync operation.
 * This is a pure rclone operation - no agent/LLM involvement.
 */
async function runSync(): Promise<void> {
  if (!currentConfig || !currentLogger) return;

  const syncConfig = currentConfig.workspace?.sync;
  if (!syncConfig?.provider || syncConfig.provider === "off") return;

  // Skip if a sync is already in progress
  if (state.syncInProgress) {
    currentLogger.info("[workspace-sync] Sync already in progress, skipping");
    return;
  }

  const logger = currentLogger;
  state.syncInProgress = true;

  try {
    // Check if rclone is available
    const installed = await isRcloneInstalled();
    if (!installed) {
      logger.warn("[workspace-sync] rclone not installed, skipping periodic sync");
      return;
    }

    // Resolve workspace and config
    const agentId = resolveDefaultAgentId(currentConfig);
    const workspaceDir = resolveAgentWorkspaceDir(currentConfig, agentId);
    const resolved = resolveSyncConfig(syncConfig, workspaceDir);

    // Auto-generate rclone config from moltbot.json if credentials present
    ensureRcloneConfigFromConfig(syncConfig, resolved.configPath, resolved.remoteName);

    // Check if configured
    if (!isRcloneConfigured(resolved.configPath, resolved.remoteName)) {
      logger.warn(`[workspace-sync] rclone not configured for "${resolved.remoteName}", skipping`);
      return;
    }

    logger.info(
      `[workspace-sync] Running periodic sync: ${resolved.remoteName}:${resolved.remotePath}`,
    );

    // Run bisync - pure file operation, no LLM involvement
    // Auto-resync on first run if no prior sync state exists
    const needsResync = !state.hasSuccessfulSync;

    let result = await runBisync({
      configPath: resolved.configPath,
      remoteName: resolved.remoteName,
      remotePath: resolved.remotePath,
      localPath: resolved.localPath,
      conflictResolve: resolved.conflictResolve,
      exclude: resolved.exclude,
      copySymlinks: resolved.copySymlinks,
      resync: needsResync,
    });

    // If failed with resync error and we didn't already try resync, retry with resync
    if (!result.ok && result.error?.includes("--resync") && !needsResync) {
      logger.info("[workspace-sync] First-time sync detected, running with --resync");
      result = await runBisync({
        configPath: resolved.configPath,
        remoteName: resolved.remoteName,
        remotePath: resolved.remotePath,
        localPath: resolved.localPath,
        conflictResolve: resolved.conflictResolve,
        exclude: resolved.exclude,
        copySymlinks: resolved.copySymlinks,
        resync: true,
      });
    }

    state.lastSyncAt = new Date();
    state.syncCount++;

    if (result.ok) {
      state.lastSyncOk = true;
      state.hasSuccessfulSync = true;
      logger.info("[workspace-sync] Periodic sync completed");
    } else {
      state.lastSyncOk = false;
      state.errorCount++;
      logger.warn(`[workspace-sync] Periodic sync failed: ${result.error}`);

      // Self-heal: if failed due to lock file, clear it for next attempt
      if (result.error?.includes("lock file found") || result.error?.includes(".lck")) {
        logger.info("[workspace-sync] Clearing lock file for next sync attempt");
        clearStaleLocks(logger);
      }
    }
  } catch (err) {
    state.lastSyncOk = false;
    state.errorCount++;
    logger.error(
      `[workspace-sync] Periodic sync error: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    state.syncInProgress = false;
  }
}

/**
 * Clear stale rclone bisync lock files.
 * Called on startup since a restart means any prior sync was interrupted.
 */
function clearStaleLocks(logger: SyncManagerLogger): void {
  const lockDir = join(homedir(), ".cache", "rclone", "bisync");
  try {
    if (!existsSync(lockDir)) return;

    const files = readdirSync(lockDir);
    const lockFiles = files.filter((f) => f.endsWith(".lck"));

    for (const lockFile of lockFiles) {
      try {
        unlinkSync(join(lockDir, lockFile));
        logger.info(`[workspace-sync] Cleared stale lock: ${lockFile}`);
      } catch {
        // Ignore errors deleting individual files
      }
    }
  } catch {
    // Lock dir doesn't exist or can't be read - that's fine
  }
}

/**
 * Start the background sync manager.
 * Called when the gateway starts.
 */
export function startWorkspaceSyncManager(cfg: MoltbotConfig, logger: SyncManagerLogger): void {
  // Stop any existing interval
  stopWorkspaceSyncManager();

  currentConfig = cfg;
  currentLogger = logger;

  const syncConfig = cfg.workspace?.sync;
  if (!syncConfig?.provider || syncConfig.provider === "off") {
    logger.info("[workspace-sync] Workspace sync not configured");
    return;
  }

  // Clear any stale locks from prior interrupted syncs
  clearStaleLocks(logger);

  const intervalSeconds = syncConfig.interval ?? 0;
  if (intervalSeconds <= 0) {
    logger.info("[workspace-sync] Periodic sync disabled (interval=0)");
    return;
  }

  // Minimum interval: 60 seconds to prevent thrashing
  const effectiveInterval = Math.max(intervalSeconds, 60);
  if (effectiveInterval !== intervalSeconds) {
    logger.warn(
      `[workspace-sync] Interval increased from ${intervalSeconds}s to ${effectiveInterval}s (minimum)`,
    );
  }

  logger.info(
    `[workspace-sync] Starting periodic sync every ${effectiveInterval}s (pure file sync, zero LLM cost)`,
  );

  // Run initial sync after a short delay (let gateway fully start)
  setTimeout(() => {
    runSync().catch(() => {});
  }, 5000);

  // Set up periodic sync
  state.intervalId = setInterval(() => {
    runSync().catch(() => {});
  }, effectiveInterval * 1000);
}

/**
 * Stop the background sync manager.
 * Called when the gateway stops.
 */
export function stopWorkspaceSyncManager(): void {
  if (state.intervalId) {
    clearInterval(state.intervalId);
    state.intervalId = null;
  }
  currentConfig = null;
  currentLogger = null;
}

/**
 * Get current sync manager status.
 */
export function getWorkspaceSyncStatus(): {
  running: boolean;
  lastSyncAt: Date | null;
  lastSyncOk: boolean | null;
  syncCount: number;
  errorCount: number;
} {
  return {
    running: state.intervalId !== null,
    lastSyncAt: state.lastSyncAt,
    lastSyncOk: state.lastSyncOk,
    syncCount: state.syncCount,
    errorCount: state.errorCount,
  };
}

/**
 * Trigger an immediate sync (for CLI use).
 */
export async function triggerImmediateSync(): Promise<void> {
  await runSync();
}
