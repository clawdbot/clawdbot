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

type RequestedSessionAgentIdResolution =
  | { ok: true; agentId: string }
  | { ok: false; error: ErrorShape };

/** Resolves only stable implicit ownership for unscoped session rows and active runs. */
export function tryResolveSessionCompatibilityOwnerAgentId(
  cfg: OpenClawConfig,
  key: string,
): string | undefined {
  const persistedStoreOwner = resolvePersistedSessionStoreOwnerForKey(cfg, key);
  if (persistedStoreOwner.kind === "configured") {
    return persistedStoreOwner.agentId;
  }
  return persistedStoreOwner.kind === "retired"
    ? undefined
    : tryResolveLegacyCompatibilityAgentId(cfg);
}

export function resolveRequestedSessionAgentId(
  cfg: OpenClawConfig,
  key: string,
  explicitAgentId?: string,
): RequestedSessionAgentIdResolution {
  const parsed = parseAgentSessionKey(key.trim());
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
    return { ok: true, agentId: keyAgentId };
  }

  const persistedStoreOwner = resolvePersistedSessionStoreOwnerForKey(cfg, key);
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
