import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  resolveDefaultAgentId,
  tryResolveLegacyCompatibilityAgentId,
} from "../agents/agent-scope-config.js";
import { resolveSessionAgentId } from "../agents/agent-scope.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../routing/session-key.js";

/** Resolves the configured owner for Talk work that has no agent-scoped session key. */
export function resolveTalkTargetAgentId(config: OpenClawConfig): string {
  return normalizeAgentId(
    normalizeOptionalString(config.talk?.agentId) ??
      tryResolveLegacyCompatibilityAgentId(config) ??
      resolveDefaultAgentId(config, {
        surface: "Talk relay ownership",
        hint: "Set talk.agentId to the agent that owns unscoped Talk sessions.",
      }),
  );
}

/** Agent-scoped keys own their Talk session; legacy/unscoped aliases use the Talk target. */
export function resolveTalkSessionAgentId(
  config: OpenClawConfig,
  sessionKey?: string | null,
): string {
  const normalizedSessionKey = sessionKey ?? undefined;
  const persistedOwner = resolvePersistedSessionStoreOwnerForKey(config, normalizedSessionKey);
  return persistedOwner.kind === "none"
    ? resolveAgentIdFromSessionKey(normalizedSessionKey, resolveTalkTargetAgentId(config))
    : resolveSessionAgentId({ config, sessionKey: normalizedSessionKey });
}
