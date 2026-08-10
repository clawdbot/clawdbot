import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { listAgentIds } from "../../agents/agent-scope-config.js";
import { classifySessionKeyShape } from "../../routing/session-key.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { isPerAgentSessionStoreConfig } from "./session-store-config.js";

export type PersistedSessionStoreOwner =
  | { kind: "none" }
  | { kind: "configured"; agentId: string }
  | { kind: "retired"; agentId: string };

/** Preserves a retired fixed-store owner as an explicit unavailable state. */
export function resolvePersistedSessionStoreOwner(
  config: OpenClawConfig,
): PersistedSessionStoreOwner {
  if (isPerAgentSessionStoreConfig(config.session?.store)) {
    return { kind: "none" };
  }
  const persistedAgentId = config.agents?.defaults?.sessionStore?.agentId?.trim();
  if (!persistedAgentId) {
    return { kind: "none" };
  }
  const agentId = normalizeAgentId(persistedAgentId);
  return listAgentIds(config).some(
    (configuredAgentId) => normalizeAgentId(configuredAgentId) === agentId,
  )
    ? { kind: "configured", agentId }
    : { kind: "retired", agentId };
}

/** Applies fixed-store ownership only to keys without an agent-qualified namespace. */
export function resolvePersistedSessionStoreOwnerForKey(
  config: OpenClawConfig,
  sessionKey: string | undefined,
): PersistedSessionStoreOwner {
  return classifySessionKeyShape(sessionKey) === "legacy_or_alias"
    ? resolvePersistedSessionStoreOwner(config)
    : { kind: "none" };
}
