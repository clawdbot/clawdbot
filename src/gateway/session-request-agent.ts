import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  type ErrorShape,
  errorShape,
} from "../../packages/gateway-protocol/src/index.js";
import { listAgentIds } from "../agents/agent-scope.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { resolveSessionStoreAgentId, resolveSessionStoreKey } from "./session-store-key.js";

type RequestedSessionAgentIdResolution =
  | { ok: true; agentId?: string }
  | { ok: false; error: ErrorShape };

export function resolveRequestedSessionAgentId(
  cfg: OpenClawConfig,
  key: string,
  explicitAgentId?: string,
): RequestedSessionAgentIdResolution {
  const canonicalKey = resolveSessionStoreKey({ cfg, sessionKey: key });
  const parsed = parseAgentSessionKey(key);
  const requestedAgentId = normalizeOptionalString(explicitAgentId);
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
  if (requestedAgentId) {
    const agentId = normalizeAgentId(requestedAgentId);
    if (!listAgentIds(cfg).includes(agentId)) {
      return {
        ok: false,
        error: errorShape(ErrorCodes.INVALID_REQUEST, `Unknown agent id "${explicitAgentId}"`),
      };
    }
    if (parsed?.agentId && normalizeAgentId(parsed.agentId) !== agentId) {
      return {
        ok: false,
        error: errorShape(ErrorCodes.INVALID_REQUEST, "session key agent does not match agentId"),
      };
    }
    if (persistedStoreOwner.kind === "configured" && persistedStoreOwner.agentId !== agentId) {
      return {
        ok: false,
        error: errorShape(ErrorCodes.INVALID_REQUEST, "session key agent does not match agentId"),
      };
    }
    if (canonicalKey !== "global") {
      const keyAgentId = parsed?.agentId
        ? normalizeAgentId(parsed.agentId)
        : normalizeAgentId(resolveSessionStoreAgentId(cfg, canonicalKey));
      if (keyAgentId !== agentId) {
        return {
          ok: false,
          error: errorShape(ErrorCodes.INVALID_REQUEST, "session key agent does not match agentId"),
        };
      }
    }
    return { ok: true, agentId };
  }
  if (!parsed?.agentId) {
    return persistedStoreOwner.kind === "configured"
      ? { ok: true, agentId: persistedStoreOwner.agentId }
      : { ok: true };
  }
  const inferredAgentId = normalizeAgentId(parsed.agentId);
  if (canonicalKey === "global" && !listAgentIds(cfg).includes(inferredAgentId)) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, `Unknown agent id "${parsed.agentId}"`),
    };
  }
  return {
    ok: true,
    agentId: canonicalKey === "global" ? inferredAgentId : undefined,
  };
}
