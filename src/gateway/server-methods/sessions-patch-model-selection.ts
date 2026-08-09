import type { SessionsPatchParams } from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import { persistStickyModelSelectionBestEffort } from "../../agents/sticky-model-selection.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";

export function persistSessionPatchModelSelection(params: {
  callerScopes: readonly string[];
  cfg: OpenClawConfig;
  entry: SessionEntry;
  patch: SessionsPatchParams;
  sessionKey: string;
  targetAgentId: string;
}): void {
  if (typeof params.patch.model !== "string") {
    return;
  }
  const parsed = parseAgentSessionKey(params.sessionKey);
  const agentId = normalizeAgentId(
    params.sessionKey === "global"
      ? params.targetAgentId
      : (parsed?.agentId ?? resolveDefaultAgentId(params.cfg)),
  );
  if (
    params.callerScopes.includes(ADMIN_SCOPE) &&
    params.entry.modelOverrideSource === "user" &&
    params.entry.providerOverride &&
    params.entry.modelOverride
  ) {
    const resolved = resolveSessionModelRef(params.cfg, params.entry, agentId);
    persistStickyModelSelectionBestEffort({
      agentId,
      model: `${resolved.provider}/${resolved.model}`,
    });
  }
}
