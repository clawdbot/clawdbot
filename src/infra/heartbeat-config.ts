/** Pure heartbeat enrollment and configuration shared by scheduling, health, and Doctor. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  listAgentEntries,
  listAgentIds,
  resolveAgentConfig,
} from "../agents/agent-scope-config.js";
import { DEFAULT_HEARTBEAT_EVERY } from "../auto-reply/heartbeat.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { tryResolveAmbientHeartbeatAgentId } from "./heartbeat-agent-resolution.js";

export type HeartbeatConfig = AgentDefaultsConfig["heartbeat"];

type HeartbeatAgent = {
  agentId: string;
  heartbeat?: HeartbeatConfig;
};

export function resolveHeartbeatConfig(
  cfg: OpenClawConfig,
  agentId?: string,
): HeartbeatConfig | undefined {
  const defaults = cfg.agents?.defaults?.heartbeat;
  if (!agentId) {
    return defaults;
  }
  const overrides = resolveAgentConfig(cfg, agentId)?.heartbeat;
  return defaults || overrides ? { ...defaults, ...overrides } : undefined;
}

/** Resolve the cadence owned by the effective heartbeat configuration. */
export function resolveHeartbeatIntervalMs(
  cfg: OpenClawConfig,
  overrideEvery?: string,
  heartbeat?: HeartbeatConfig,
) {
  const raw =
    overrideEvery ??
    heartbeat?.every ??
    cfg.agents?.defaults?.heartbeat?.every ??
    DEFAULT_HEARTBEAT_EVERY;
  const trimmed = normalizeOptionalString(raw);
  if (!trimmed) {
    return null;
  }
  try {
    const intervalMs = parseDurationMs(trimmed, { defaultUnit: "m" });
    return intervalMs > 0 ? intervalMs : null;
  } catch {
    return null;
  }
}

export function resolveHeartbeatAgents(cfg: OpenClawConfig): HeartbeatAgent[] {
  const explicitAgents = listAgentEntries(cfg).filter((entry) => entry.heartbeat);
  if (explicitAgents.length > 0) {
    return explicitAgents
      .map((entry) => {
        const agentId = normalizeAgentId(entry.id);
        return { agentId, heartbeat: resolveHeartbeatConfig(cfg, agentId) };
      })
      .filter((agent) => agent.agentId);
  }
  const configuredAgentId = normalizeOptionalString(cfg.agents?.defaults?.heartbeat?.agentId);
  if (configuredAgentId) {
    const agentId = normalizeAgentId(configuredAgentId);
    return [{ agentId, heartbeat: resolveHeartbeatConfig(cfg, agentId) }];
  }
  if (cfg.agents?.defaults?.heartbeat) {
    return listAgentIds(cfg).map((agentId) => ({
      agentId,
      heartbeat: resolveHeartbeatConfig(cfg, agentId),
    }));
  }
  const agentId = tryResolveAmbientHeartbeatAgentId(cfg);
  return agentId ? [{ agentId, heartbeat: resolveHeartbeatConfig(cfg, agentId) }] : [];
}

export function isHeartbeatOwnerUnresolved(cfg: OpenClawConfig): boolean {
  return listAgentIds(cfg).length > 1 && resolveHeartbeatAgents(cfg).length === 0;
}
