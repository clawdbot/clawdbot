// Summarizes heartbeat config for CLI and UI display.
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

/** Return whether heartbeat scheduling applies to an agent. */
export function isHeartbeatEnabledForAgent(cfg: OpenClawConfig, agentId?: string): boolean {
  const resolvedAgentId = agentId ?? tryResolveAmbientHeartbeatAgentId(cfg);
  return (
    resolvedAgentId !== undefined &&
    resolveHeartbeatAgents(cfg).some((agent) => agent.agentId === normalizeAgentId(resolvedAgentId))
  );
}

/** Resolve display-ready heartbeat settings for an agent. */
export function resolveHeartbeatSummaryForAgent(
  cfg: OpenClawConfig,
  agentId?: string,
): HeartbeatSummary {
  const merged = resolveHeartbeatConfig(cfg, agentId);
  const everyMs = resolveHeartbeatIntervalMs(cfg, undefined, merged);
  const enabled = isHeartbeatEnabledForAgent(cfg, agentId) && everyMs !== null;

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
