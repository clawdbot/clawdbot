import { listAgentEntries, listAgentIds, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveMemoryBackendConfig,
  type ResolvedQmdConfig,
} from "../memory-host-sdk/host/backend-config.js";
import { getActiveMemorySearchManager } from "../plugins/memory-runtime.js";
import { normalizeAgentId } from "../routing/session-key.js";

function shouldRunQmdStartupBootSync(qmd: ResolvedQmdConfig): boolean {
  return qmd.update.onBoot && qmd.update.startup !== "off";
}

function hasExplicitAgentMemorySearchConfig(cfg: OpenClawConfig, agentId: string): boolean {
  return listAgentEntries(cfg).some(
    (entry) => normalizeAgentId(entry.id) === agentId && entry.memorySearch != null,
  );
}

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
  if (params.cfg.agents?.defaults?.memorySearch?.enabled === true) {
    return true;
  }
  return hasExplicitAgentMemorySearchConfig(params.cfg, params.agentId);
}

export async function startGatewayMemoryBackend(params: {
  cfg: OpenClawConfig;
  log: { info?: (msg: string) => void; warn: (msg: string) => void };
}): Promise<void> {
  const agentIds = listAgentIds(params.cfg);
  const armedAgentIds: string[] = [];
  const deferredAgentIds: string[] = [];
  for (const agentId of agentIds) {
    if (!resolveMemorySearchConfig(params.cfg, agentId)) {
      continue;
    }
    const resolved = resolveMemoryBackendConfig({ cfg: params.cfg, agentId });
    if (!resolved) {
      continue;
    }
    if (resolved.backend !== "qmd" || !resolved.qmd) {
      continue;
    }
    if (!shouldRunQmdStartupBootSync(resolved.qmd)) {
      continue;
    }
    if (
      !shouldEagerlyStartAgentMemory({
        cfg: params.cfg,
        agentId,
        agentCount: agentIds.length,
      })
    ) {
      deferredAgentIds.push(agentId);
      continue;
    }

    const { manager, error } = await getActiveMemorySearchManager({
      cfg: params.cfg,
      agentId,
      purpose: "cli",
    });
    if (!manager) {
      params.log.warn(
        `qmd memory startup initialization failed for agent "${agentId}": ${error ?? "unknown error"}`,
      );
      continue;
    }
    try {
      await manager.sync?.({ reason: "boot", force: true });
    } catch (err) {
      params.log.warn(`qmd memory startup boot sync failed for agent "${agentId}": ${String(err)}`);
      continue;
    } finally {
      await manager.close?.().catch((err) => {
        params.log.warn(
          `qmd memory startup manager close failed for agent "${agentId}": ${String(err)}`,
        );
      });
    }
    armedAgentIds.push(agentId);
  }
  if (armedAgentIds.length > 0) {
    params.log.info?.(
      `qmd memory startup boot sync completed for ${formatAgentCount(armedAgentIds.length)}: ${armedAgentIds
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
