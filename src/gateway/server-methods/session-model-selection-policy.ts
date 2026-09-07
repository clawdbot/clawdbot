import {
  resolveStickyModelSelectionPolicy,
  type StickyModelSelectionPolicy,
} from "../../agents/sticky-model-selection.js";
import { resolveIsConfigReadOnly } from "../../config/paths.js";
import type { ModelSelectionScope } from "../../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";

export function resolveGatewayModelSelectionPolicy(params: {
  callerScopes: readonly string[];
  cfg: OpenClawConfig;
  scope?: ModelSelectionScope;
}): StickyModelSelectionPolicy {
  return resolveStickyModelSelectionPolicy({
    canPersistConfig:
      params.callerScopes.includes(ADMIN_SCOPE) && !resolveIsConfigReadOnly(process.env),
    cfg: params.cfg,
    ...(params.scope ? { scope: params.scope } : {}),
  });
}
