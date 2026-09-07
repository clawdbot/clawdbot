/**
 * Heartbeat enrollment and summary projection shared by the public
 * heartbeat-summary module and the health/status snapshot builders. Lives
 * outside heartbeat-summary.ts because that module is wildcard re-exported by
 * the plugin SDK: the fleet-wide resolver is an internal snapshot helper, not
 * public API, and must not widen the SDK surface.
 */
import { withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import {
  DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  DEFAULT_HEARTBEAT_EVERY,
  resolveHeartbeatPromptCore as resolveHeartbeatPromptText,
} from "../auto-reply/heartbeat.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { tryResolveAmbientHeartbeatAgentId } from "./heartbeat-agent-resolution.js";
import {
  resolveHeartbeatAgents,
  resolveHeartbeatConfig,
  resolveHeartbeatIntervalMs,
} from "./heartbeat-config.js";

/** Normalized heartbeat configuration for one agent. */
export type HeartbeatSummary = {
  enabled: boolean;
  every: string;
  everyMs: number | null;
  prompt: string;
  target: string;
  model?: string;
  session?: string;
  ackMaxChars: number;
};

const DEFAULT_HEARTBEAT_TARGET = "owner";

export function enrolledHeartbeatAgentIds(cfg: OpenClawConfig): ReadonlySet<string> {
  return new Set(resolveHeartbeatAgents(cfg).map((agent) => agent.agentId));
}

export function isEnrolledHeartbeatAgent(
  cfg: OpenClawConfig,
  agentId: string | undefined,
  enrolled: ReadonlySet<string>,
): boolean {
  const resolvedAgentId = agentId ?? tryResolveAmbientHeartbeatAgentId(cfg);
  return resolvedAgentId !== undefined && enrolled.has(normalizeAgentId(resolvedAgentId));
}

export function buildHeartbeatSummary(
  cfg: OpenClawConfig,
  agentId: string | undefined,
  enrolled: ReadonlySet<string>,
): HeartbeatSummary {
  const merged = resolveHeartbeatConfig(cfg, agentId);
  const everyMs = resolveHeartbeatIntervalMs(cfg, undefined, merged);
  const enabled = isEnrolledHeartbeatAgent(cfg, agentId, enrolled) && everyMs !== null;

  return {
    enabled,
    every: enabled ? (merged?.every ?? DEFAULT_HEARTBEAT_EVERY) : "disabled",
    everyMs: enabled ? everyMs : null,
    prompt: resolveHeartbeatPromptText(merged?.prompt),
    target: merged?.target ?? DEFAULT_HEARTBEAT_TARGET,
    model: merged?.model,
    session: merged?.session,
    ackMaxChars: DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  };
}

/**
 * Display-ready heartbeat settings for many agents from one roster pass, in
 * input order. Health and status project every configured agent; resolving
 * enrollment per agent re-walks the roster each time, so a large fleet blocked
 * the Gateway event loop for tens of seconds per refresh (#137570).
 */
export function resolveHeartbeatSummariesForAgents(
  cfg: OpenClawConfig,
  agentIds: readonly string[],
): HeartbeatSummary[] {
  return withAgentRosterFactsBatch(cfg, () => {
    const enrolled = enrolledHeartbeatAgentIds(cfg);
    return agentIds.map((agentId) => buildHeartbeatSummary(cfg, agentId, enrolled));
  });
}
