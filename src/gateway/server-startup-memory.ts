// Gateway memory startup helper.
// Starts qmd memory boot sync for eligible agents without loading every agent.
import { listAgentEntries, listAgentIds, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveMemoryBackendConfig,
  type ResolvedQmdConfig,
} from "../memory-host-sdk/host/backend-config.js";
import { getActiveMemorySearchManager } from "../plugins/memory-runtime.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { SecretSurfaceUnavailableError } from "../secrets/runtime-degraded-state.js";

/** True when qmd memory config opts into Gateway startup manager work. */
function shouldRunQmdStartupManager(qmd: ResolvedQmdConfig): boolean {
  return (
    qmd.update.startup !== "off" && (qmd.update.onBoot || shouldKeepQmdStartupManagerAlive(qmd))
  );
}

/** True when startup needs the full manager to own QMD background timers. */
function shouldKeepQmdStartupManagerAlive(qmd: ResolvedQmdConfig): boolean {
  return qmd.update.intervalMs > 0 || qmd.update.embedIntervalMs > 0;
}

/** Check whether an agent overrides memory search instead of inheriting defaults. */
function hasExplicitAgentMemorySearchConfig(cfg: OpenClawConfig, agentId: string): boolean {
  return listAgentEntries(cfg).some(
    (entry) => normalizeAgentId(entry.id) === agentId && entry.memory?.search != null,
  );
}

/** Decide whether an agent's qmd memory manager should start during Gateway boot. */
function shouldEagerlyStartAgentMemory(params: {
  cfg: OpenClawConfig;
  agentId: string;
  agentCount: number;
}): boolean {
  if (params.agentCount <= 1) {
    return true;
  }
  if (params.agentId === resolveDefaultAgentId(params.cfg)) {
    return true;
  }
  if (params.cfg.memory?.search?.enabled === true) {
    return true;
  }
  return hasExplicitAgentMemorySearchConfig(params.cfg, params.agentId);
}

/** Start qmd memory boot sync for eligible agents without eagerly loading every agent. */
export async function startGatewayMemoryBackend(params: {
  cfg: OpenClawConfig;
  log: { info?: (msg: string) => void; warn: (msg: string) => void };
}): Promise<void> {
  const agentIds = listAgentIds(params.cfg);
  const bootSyncAgentIds: string[] = [];
  const initializedAgentIds: string[] = [];
  const deferredAgentIds: string[] = [];
  for (const agentId of agentIds) {
    try {
      if (!resolveMemorySearchConfig(params.cfg, agentId)) {
        continue;
      }
    } catch (error) {
      if (!(error instanceof SecretSurfaceUnavailableError)) {
        throw error;
      }
      // One isolated provider must not prevent healthy agents from completing
      // Gateway-owned boot sync and background manager initialization.
      params.log.warn(`memory startup unavailable for agent "${agentId}": ${error.message}`);
      continue;
    }
    const resolved = resolveMemoryBackendConfig({ cfg: params.cfg, agentId });
    if (!resolved) {
      continue;
    }
    if (resolved.backend !== "qmd" || !resolved.qmd) {
      continue;
    }
    if (!shouldRunQmdStartupManager(resolved.qmd)) {
      continue;
    }
    if (
      !shouldEagerlyStartAgentMemory({
        cfg: params.cfg,
        agentId,
        agentCount: agentIds.length,
      })
    ) {
      // Multi-agent configs keep unconfigured non-default agents lazy so
      // Gateway startup does not initialize every possible qmd store.
      deferredAgentIds.push(agentId);
      continue;
    }

    const keepManagerAlive = shouldKeepQmdStartupManagerAlive(resolved.qmd);
    const { manager, error } = await getActiveMemorySearchManager({
      cfg: params.cfg,
      agentId,
      purpose: keepManagerAlive ? "default" : "cli",
    });
    if (!manager) {
      params.log.warn(
        `qmd memory startup initialization failed for agent "${agentId}": ${error ?? "unknown error"}`,
      );
      continue;
    }
    if (keepManagerAlive) {
      initializedAgentIds.push(agentId);
      continue;
    }
    try {
      await manager.sync?.({ reason: "boot", force: true });
    } catch (err) {
      params.log.warn(`qmd memory startup boot sync failed for agent "${agentId}": ${String(err)}`);
      continue;
    } finally {
      await manager.close?.().catch((err: unknown) => {
        params.log.warn(
          `qmd memory startup manager close failed for agent "${agentId}": ${String(err)}`,
        );
      });
    }
    bootSyncAgentIds.push(agentId);
  }
  if (bootSyncAgentIds.length > 0) {
    params.log.info?.(
      `qmd memory startup boot sync completed for ${formatAgentCount(bootSyncAgentIds.length)}: ${bootSyncAgentIds
        .map((agentId) => `"${agentId}"`)
        .join(", ")}`,
    );
  }
  if (initializedAgentIds.length > 0) {
    params.log.info?.(
      `qmd memory startup manager initialized for ${formatAgentCount(initializedAgentIds.length)}: ${initializedAgentIds
        .map((agentId) => `"${agentId}"`)
        .join(", ")}`,
    );
  }
  if (deferredAgentIds.length > 0) {
    params.log.info?.(
      `qmd memory startup initialization deferred for ${formatAgentCount(deferredAgentIds.length)}: ${deferredAgentIds
        .map((agentId) => `"${agentId}"`)
        .join(", ")}`,
    );
  }
}

function formatAgentCount(count: number): string {
  return count === 1 ? "1 agent" : `${count} agents`;
}
