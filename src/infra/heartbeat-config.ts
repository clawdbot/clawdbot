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

/** Enrollment owned by `agents.defaults.heartbeat` and the ambient owner chain. */
function resolveAmbientHeartbeatAgents(cfg: OpenClawConfig): HeartbeatAgent[] {
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

export function resolveHeartbeatAgents(cfg: OpenClawConfig): HeartbeatAgent[] {
  const explicitAgents = listAgentEntries(cfg)
    .filter((entry) => entry.heartbeat)
    .map((entry) => {
      const agentId = normalizeAgentId(entry.id);
      return { agentId, heartbeat: resolveHeartbeatConfig(cfg, agentId) };
    })
    .filter((agent) => agent.agentId);
  // A per-agent block selects the enrolled agents, but a block whose merged
  // cadence is disabled ("0m") is an opt-out, not an enrollment selector.
  // Without this check, disabling one agent would silently unenroll every
  // sibling that inherits `agents.defaults.heartbeat`.
  const optsInSomeAgent = explicitAgents.some(
    (agent) => resolveHeartbeatIntervalMs(cfg, undefined, agent.heartbeat) !== null,
  );
  if (optsInSomeAgent) {
    return explicitAgents;
  }
  // Keep the opted-out agents enrolled with their disabled cadence so their
  // monitor row and scratch are retained for re-enabling.
  const agents = new Map(resolveAmbientHeartbeatAgents(cfg).map((agent) => [agent.agentId, agent]));
  for (const agent of explicitAgents) {
    if (!agents.has(agent.agentId)) {
      agents.set(agent.agentId, agent);
    }
  }
  return [...agents.values()];
}

export function isHeartbeatOwnerUnresolved(cfg: OpenClawConfig): boolean {
  return listAgentIds(cfg).length > 1 && resolveHeartbeatAgents(cfg).length === 0;
}
