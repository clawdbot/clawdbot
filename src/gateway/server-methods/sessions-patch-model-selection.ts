import type { SessionsPatchParams } from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import {
  persistStickyModelSelectionBestEffort,
  resolveStickyModelSelectionScope,
} from "../../agents/sticky-model-selection.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";

export function persistSessionPatchModelSelection(params: {
  callerScopes: readonly string[];
  cfg: OpenClawConfig;
  entry: SessionEntry;
  patch: SessionsPatchParams;
  sessionKey: string;
  targetAgentId: string;
}): void {
  const scope = resolveStickyModelSelectionScope({ cfg: params.cfg });
  if (
    typeof params.patch.model !== "string" ||
    !params.callerScopes.includes(ADMIN_SCOPE) ||
    scope === "session" ||
    // Selecting the effective default clears the pin. Preserve the legacy skip
    // unless the operator explicitly configured an agent/global write target.
    (scope === "effective" &&
      (params.entry.modelOverrideSource !== "user" ||
        !params.entry.providerOverride ||
        !params.entry.modelOverride))
  ) {
    return;
  }
  const agentId = resolveSessionAgentId({
    config: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.targetAgentId,
  });
  const resolved = resolveSessionModelRef(params.cfg, params.entry, agentId);
  persistStickyModelSelectionBestEffort({
    agentId,
    model: `${resolved.provider}/${resolved.model}`,
    ...(scope === "agent" ? { target: "agent" } : scope === "global" ? { target: "defaults" } : {}),
  });
}
