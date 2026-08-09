import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";

export function resolveAmbientHeartbeatAgentId(cfg: OpenClawConfig): string {
  return normalizeAgentId(
    normalizeOptionalString(cfg.agents?.defaults?.heartbeat?.agentId) ??
      resolveDefaultAgentId(cfg, {
        surface: "ambient heartbeat scheduling",
        hint: "Set agents.defaults.heartbeat.agentId to the agent that owns ambient heartbeats.",
      }),
  );
}
