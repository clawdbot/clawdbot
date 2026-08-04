/**
 * Subagent requester store-key normalization.
 *
 * Converts raw requester session keys into the canonical registry key shape.
 */
import {
  resolveAgentIdFromSessionKey,
  resolveMainSessionKey,
} from "../config/sessions/main-session.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeMainKey } from "../routing/session-key.js";
import { resolveDefaultAgentId } from "./agent-scope-config.js";

/** Resolve the canonical store key for a subagent requester session. */
export function resolveRequesterStoreKey(cfg: OpenClawConfig, requesterSessionKey: string): string {
  const raw = (requesterSessionKey ?? "").trim();
  if (!raw) {
    return raw;
  }
  if (raw === "global" || raw === "unknown") {
    return raw;
  }
  if (raw.startsWith("agent:")) {
    return raw;
  }
  const mainKey = normalizeMainKey(cfg?.session?.mainKey);
  if (raw === "main" || raw === mainKey) {
    return resolveMainSessionKey(cfg);
  }
  const agentId = resolveAgentIdFromSessionKey(raw, resolveDefaultAgentId(cfg));
  return `agent:${agentId}:${raw}`;
}
