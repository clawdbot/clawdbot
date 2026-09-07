import {
  ErrorCodes,
  type ErrorShape,
  errorShape,
} from "../../packages/gateway-protocol/src/index.js";
import { AgentSelectionRequiredError, listAgentIds } from "../agents/agent-scope.js";
import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeAgentId,
  normalizeAgentIdStrict,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { resolveSessionSubscriptionKeys } from "./session-subscription-keys.js";

type RequestedSessionAgentIdResolution =
  | { ok: true; agentId: string }
  | { ok: false; error: ErrorShape };

/** Public identity, private routing identity, then raw-global compatibility owner. */
export type SessionEventAgentScope = readonly [
  eventAgentId: string | undefined,
  routingAgentId: string | undefined,
  compatibilityOwnerAgentId: string | undefined,
];

/** Resolves public event identity separately from private session routing ownership. */
export function resolveSessionEventAgentScope(
  cfg: OpenClawConfig,
  key: string,
  explicitAgentId?: string,
  publishQualifiedAgent = false,
): SessionEventAgentScope | null {
  const parsed = parseAgentSessionKey(key.trim());
  const keyAgentId = parsed?.agentId ? normalizeAgentId(parsed.agentId) : undefined;
  const explicit = explicitAgentId === undefined ? null : normalizeAgentIdStrict(explicitAgentId);
  if (explicit !== null && !explicit.ok) {
    return null;
  }
  if (explicit?.value && keyAgentId && explicit.value !== keyAgentId) {
    return null;
  }
  const persistedOwner = resolvePersistedSessionStoreOwnerForKey(cfg, key);
  const compatibilityOwnerAgentId = keyAgentId
    ? undefined
    : tryResolveSessionCompatibilityOwnerAgentId(cfg, key);
  const eventAgentId =
    explicit?.value ??
    (publishQualifiedAgent && keyAgentId && listAgentIds(cfg).includes(keyAgentId)
      ? keyAgentId
      : undefined);
  const routingAgentId =
    explicit?.value ??
    keyAgentId ??
    compatibilityOwnerAgentId ??
    (persistedOwner.kind === "retired" ? persistedOwner.agentId : undefined);
  return [eventAgentId, routingAgentId, compatibilityOwnerAgentId];
}

/** Binds a retired unqualified owner to its private sharing scope. */
export function resolvePrivateSessionEventBroadcastScope(
  key: string | undefined,
  [eventAgentId, routingAgentId, compatibilityOwnerAgentId]: SessionEventAgentScope,
) {
  return key &&
    !parseAgentSessionKey(key) &&
    !eventAgentId &&
    routingAgentId &&
    !compatibilityOwnerAgentId
    ? {
        agentId: routingAgentId,
        sessionKeys: resolveSessionSubscriptionKeys(key, routingAgentId),
      }
    : undefined;
}

/** Resolves only stable implicit ownership for unscoped session rows and active runs. */
export function tryResolveSessionCompatibilityOwnerAgentId(
  cfg: OpenClawConfig,
  key: string | undefined,
): string | undefined {
  const persistedStoreOwner = resolvePersistedSessionStoreOwnerForKey(cfg, key);
  if (persistedStoreOwner.kind === "configured") {
    return persistedStoreOwner.agentId;
  }
  return persistedStoreOwner.kind === "retired"
    ? undefined
    : tryResolveLegacyCompatibilityAgentId(cfg);
}

// An absent key selects an agent before a session exists; a synthetic main key
// would incorrectly admit a fixed global target instead of a fresh child.
export function resolveRequestedSessionAgentId(
  cfg: OpenClawConfig,
  key: string | undefined,
  explicitAgentId?: string,
): RequestedSessionAgentIdResolution {
  const parsed = parseAgentSessionKey(key?.trim());
  const configuredAgentIds = listAgentIds(cfg);
  const normalizedRequest =
    explicitAgentId === undefined ? null : normalizeAgentIdStrict(explicitAgentId);
  if (normalizedRequest && !normalizedRequest.ok) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, `Unknown agent id "${explicitAgentId}"`),
    };
  }
  const normalizedRequestedAgentId = normalizedRequest?.value;
  if (normalizedRequestedAgentId && !configuredAgentIds.includes(normalizedRequestedAgentId)) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, `Unknown agent id "${explicitAgentId}"`),
    };
  }
  let ownerKey = key;
  if (parsed?.agentId) {
    const keyAgentId = normalizeAgentId(parsed.agentId);
    const keyIsGlobalMainAlias =
      cfg.session?.scope === "global" &&
      (parsed.rest === "main" || parsed.rest === normalizeMainKey(cfg.session?.mainKey));
    if (keyIsGlobalMainAlias && !configuredAgentIds.includes(keyAgentId)) {
      return {
        ok: false,
        error: errorShape(ErrorCodes.INVALID_REQUEST, `Unknown agent id "${parsed.agentId}"`),
      };
    }
    if (normalizedRequestedAgentId && keyAgentId !== normalizedRequestedAgentId) {
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          `agent "${explicitAgentId}" does not match session key agent "${keyAgentId}"`,
        ),
      };
    }
    if (!keyIsGlobalMainAlias || !normalizedRequestedAgentId) {
      return { ok: true, agentId: keyAgentId };
    }
    // Explicit targets must also match the fixed store after losing their prefix.
    ownerKey = "global";
  }

  const persistedStoreOwner = resolvePersistedSessionStoreOwnerForKey(cfg, ownerKey);
  if (persistedStoreOwner.kind === "retired") {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        `session key belongs to retired agent "${persistedStoreOwner.agentId}"`,
      ),
    };
  }
  if (normalizedRequestedAgentId) {
    if (
      persistedStoreOwner.kind === "configured" &&
      persistedStoreOwner.agentId !== normalizedRequestedAgentId
    ) {
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          `agent "${explicitAgentId}" does not match session key agent "${persistedStoreOwner.agentId}"`,
        ),
      };
    }
    return { ok: true, agentId: normalizedRequestedAgentId };
  }
  const inferredAgentId = tryResolveSessionCompatibilityOwnerAgentId(cfg, key);
  if (inferredAgentId) {
    return { ok: true, agentId: inferredAgentId };
  }
  const selectionError = new AgentSelectionRequiredError(configuredAgentIds, {
    surface: `session key "${key}"`,
    hint: "Pass agentId or use an agent-prefixed session key.",
  });
  return {
    ok: false,
    error: errorShape(ErrorCodes.INVALID_REQUEST, selectionError.message),
  };
}
