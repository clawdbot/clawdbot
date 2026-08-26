import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  classifySessionKeyShape,
  isUnscopedSessionKeySentinel,
  scopeLegacySessionKeyToAgent,
} from "../../routing/session-key.js";
import { resolveSessionAgentIds } from "../agent-scope.js";

export function resolveExplicitAgentCommandSessionKey(params: {
  rawExplicitSessionKey?: string;
  agentIdOverride?: string;
  shouldScopeDefaultAgentKey?: boolean;
  cfg: OpenClawConfig;
}): string | undefined {
  if (
    isUnscopedSessionKeySentinel(params.rawExplicitSessionKey) &&
    !params.agentIdOverride &&
    !params.shouldScopeDefaultAgentKey
  ) {
    return params.rawExplicitSessionKey;
  }
  const unscopedOwnerAgentId =
    classifySessionKeyShape(params.rawExplicitSessionKey) === "legacy_or_alias" &&
    (params.agentIdOverride || params.shouldScopeDefaultAgentKey)
      ? resolveSessionAgentIds({
          config: params.cfg,
          agentId: params.agentIdOverride,
          sessionKey: params.rawExplicitSessionKey,
        }).sessionAgentId
      : undefined;
  return scopeLegacySessionKeyToAgent({
    agentId: unscopedOwnerAgentId ?? params.agentIdOverride,
    sessionKey: params.rawExplicitSessionKey,
    mainKey: params.cfg.session?.mainKey,
  });
}
