// Summarizes heartbeat config for CLI and UI display.
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

export { resolveHeartbeatIntervalMs };

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

function enrolledHeartbeatAgentIds(cfg: OpenClawConfig): ReadonlySet<string> {
  return new Set(resolveHeartbeatAgents(cfg).map((agent) => agent.agentId));
}

function isEnrolledHeartbeatAgent(
  cfg: OpenClawConfig,
  agentId: string | undefined,
  enrolled: ReadonlySet<string>,
): boolean {
  const resolvedAgentId = agentId ?? tryResolveAmbientHeartbeatAgentId(cfg);
  return resolvedAgentId !== undefined && enrolled.has(normalizeAgentId(resolvedAgentId));
}

/** Return whether heartbeat scheduling applies to an agent. */
export function isHeartbeatEnabledForAgent(cfg: OpenClawConfig, agentId?: string): boolean {
  return isEnrolledHeartbeatAgent(cfg, agentId, enrolledHeartbeatAgentIds(cfg));
}

/** Resolve display-ready heartbeat settings for an agent. */
export function resolveHeartbeatSummaryForAgent(
  cfg: OpenClawConfig,
  agentId?: string,
): HeartbeatSummary {
  return buildHeartbeatSummary(cfg, agentId, enrolledHeartbeatAgentIds(cfg));
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

function buildHeartbeatSummary(
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
