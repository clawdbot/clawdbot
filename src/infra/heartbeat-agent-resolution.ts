import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { tryResolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";

export function tryResolveAmbientHeartbeatAgentId(cfg: OpenClawConfig): string | undefined {
  const resolved =
    normalizeOptionalString(cfg.agents?.defaults?.heartbeat?.agentId) ??
    tryResolveAmbientOwnerAgentId(cfg);
  return resolved ? normalizeAgentId(resolved) : undefined;
}
