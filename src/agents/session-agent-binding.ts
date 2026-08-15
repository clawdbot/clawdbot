/**
 * Session-to-agent binding resolver.
 *
 * Derives the trusted active agent from explicit agent ids, agent session keys, or configured main-session aliases.
 */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolvePersistedSessionStoreOwnerForKey } from "../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeMainKey, parseAgentSessionKey } from "../routing/session-key.js";
import { resolveSessionAgentId } from "./agent-scope.js";

/**
 * Resolve the trusted active agent bound to a host-owned session reference.
 */
export function resolveBoundAgentIdForSession(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
}): string | undefined {
  const config = params.config ?? {};
  const agentId = normalizeOptionalString(params.agentId);
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!agentId && !sessionKey) {
    return undefined;
  }
  if (agentId) {
    return resolveSessionAgentId({ config, sessionKey, agentId });
  }

  const persistedOwner = resolvePersistedSessionStoreOwnerForKey(config, sessionKey);
  const loweredSessionKey = normalizeLowercaseStringOrEmpty(sessionKey);
  const mainKey = normalizeMainKey(config.session?.mainKey);
  const hasTrustedBinding =
    Boolean(parseAgentSessionKey(sessionKey)?.agentId) ||
    persistedOwner.kind !== "none" ||
    loweredSessionKey === "main" ||
    loweredSessionKey === mainKey;
  return hasTrustedBinding ? resolveSessionAgentId({ config, sessionKey }) : undefined;
}
