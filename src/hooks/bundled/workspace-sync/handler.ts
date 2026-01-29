/**
 * Workspace sync hook handler
 *
 * Syncs workspace with cloud storage on session start/end
 * when workspace.sync is configured.
 */

import type { MoltbotConfig } from "../../../config/config.js";
import { resolveAgentWorkspaceDir } from "../../../agents/agent-scope.js";
import { resolveAgentIdFromSessionKey } from "../../../routing/session-key.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookHandler } from "../../hooks.js";
import {
  isRcloneInstalled,
  isRcloneConfigured,
  ensureRcloneConfigFromConfig,
  resolveSyncConfig,
  runBisync,
} from "../../../infra/rclone.js";

const log = createSubsystemLogger("workspace-sync");

/**
 * Sync workspace on session start or end
 */
const workspaceSyncHandler: HookHandler = async (event) => {
  // Only handle session events
  if (event.type !== "session") {
    return;
  }

  const context = event.context || {};
  const cfg = context.cfg as MoltbotConfig | undefined;

  if (!cfg?.workspace?.sync) {
    return;
  }

  const syncConfig = cfg.workspace.sync;

  // Check if sync is enabled for this event
  const isStart = event.action === "start";
  const isEnd = event.action === "end" || event.action === "stop";

  if (isStart && !syncConfig.onSessionStart) {
    return;
  }

  if (isEnd && !syncConfig.onSessionEnd) {
    return;
  }

  if (!isStart && !isEnd) {
    return;
  }

  // Check if provider is configured
  if (!syncConfig.provider || syncConfig.provider === "off") {
    return;
  }

  log.info(`triggered on session ${event.action}`);

  try {
    // Check if rclone is installed
    const installed = await isRcloneInstalled();
    if (!installed) {
      log.warn("rclone not installed, skipping sync");
      return;
    }

    // Resolve workspace and config
    const agentId = resolveAgentIdFromSessionKey(event.sessionKey);
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const stateDir = context.stateDir as string | undefined;

    const resolved = resolveSyncConfig(syncConfig, workspaceDir, stateDir);

    // Auto-generate rclone config from moltbot.json if credentials present
    ensureRcloneConfigFromConfig(syncConfig, resolved.configPath, resolved.remoteName);

    // Check if rclone is configured
    if (!isRcloneConfigured(resolved.configPath, resolved.remoteName)) {
      log.warn(`rclone not configured for remote "${resolved.remoteName}", skipping sync`);
      return;
    }

    log.info(`syncing ${resolved.remoteName}:${resolved.remotePath} <-> ${resolved.localPath}`);

    // Run sync
    const result = await runBisync({
      configPath: resolved.configPath,
      remoteName: resolved.remoteName,
      remotePath: resolved.remotePath,
      localPath: resolved.localPath,
      conflictResolve: resolved.conflictResolve,
      exclude: resolved.exclude,
      copySymlinks: resolved.copySymlinks,
      verbose: false,
    });

    if (result.ok) {
      log.info("sync completed successfully");
      if (result.filesTransferred) {
        log.info(`files transferred: ${result.filesTransferred}`);
      }
    } else {
      // Check if this is a first-run issue
      if (result.error?.includes("--resync")) {
        log.warn("first sync requires manual --resync. Run: moltbot workspace sync --resync");
      } else {
        log.error(`sync failed: ${result.error}`);
      }
    }
  } catch (err) {
    log.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
};

export default workspaceSyncHandler;
