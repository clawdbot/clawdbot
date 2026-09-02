// Narrow agent-scope helpers for control-plane and migration paths.

import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  AgentSelectionRequiredError,
  tryResolveAmbientOwnerAgentId,
} from "../agents/agent-scope-config.js";
import {
  resolveSessionAgentIdStrict,
  resolveSessionAgentIdsStrict,
} from "../agents/agent-scope.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../config/sessions/session-store-owner.js";

export {
  listAgentIds,
  resolveAgentConfig,
  resolveAgentDir,
  resolveDefaultAgentId,
  tryResolveDefaultAgentId,
} from "../agents/agent-scope.js";

export { resolveSessionAgentIdStrict, resolveSessionAgentIdsStrict };

type SessionAgentResolutionParams = Parameters<typeof resolveSessionAgentIdsStrict>[0];

/**
 * @deprecated Use `resolveSessionAgentIdsStrict` with an explicit or prepared
 * owner. Retained through 2026-11-29 for plugins shipped before strict
 * multi-agent ownership was introduced.
 */
function resolveSessionAgentIdsCompatibility(params: SessionAgentResolutionParams): {
  defaultAgentId: string;
  sessionAgentId: string;
} {
  try {
    return resolveSessionAgentIdsStrict(params);
  } catch (error) {
    const requestedAgentId =
      normalizeOptionalString(params.agentId) ?? normalizeOptionalString(params.fallbackAgentId);
    const config = params.config ?? {};
    if (
      !(error instanceof AgentSelectionRequiredError) ||
      requestedAgentId ||
      resolvePersistedSessionStoreOwnerForKey(config, params.sessionKey).kind !== "none"
    ) {
      throw error;
    }
    const ambientAgentId = tryResolveAmbientOwnerAgentId(config);
    if (!ambientAgentId) {
      throw error;
    }
    return resolveSessionAgentIdsStrict({ ...params, fallbackAgentId: ambientAgentId });
  }
}

/**
 * @deprecated Use `resolveSessionAgentIdStrict` with an explicit or prepared
 * owner. Retained through 2026-11-29 for plugins shipped before strict
 * multi-agent ownership was introduced.
 */
function resolveSessionAgentIdCompatibility(params: SessionAgentResolutionParams): string {
  return resolveSessionAgentIdsCompatibility(params).sessionAgentId;
}

export {
  resolveSessionAgentIdCompatibility as resolveSessionAgentId,
  resolveSessionAgentIdsCompatibility as resolveSessionAgentIds,
};
