import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSandboxSessionToolsVisibility } from "../../plugin-sdk/session-visibility.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-resolution.js";

export {
  createAgentToAgentPolicy,
  createSessionVisibilityChecker,
  createSessionVisibilityGuard,
  createSessionVisibilityRowChecker,
  listSpawnedSessionKeys,
  resolveEffectiveSessionToolsVisibility,
} from "../../plugin-sdk/session-visibility.js";

export function resolveSandboxedSessionToolContext(params: {
  cfg: OpenClawConfig;
  agentSessionKey?: string;
  sandboxed?: boolean;
}): {
  mainKey: string;
  alias: string;
  visibility: "spawned" | "all";
  requesterInternalKey: string | undefined;
  effectiveRequesterKey: string;
  restrictToSpawned: boolean;
} {
  const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
  const visibility = resolveSandboxSessionToolsVisibility(params.cfg);
  const requesterSessionKey = normalizeOptionalString(params.agentSessionKey);
  const requesterInternalKey = requesterSessionKey
    ? resolveInternalSessionKey({
        key: requesterSessionKey,
        alias,
        mainKey,
      })
    : undefined;
  const effectiveRequesterKey = requesterInternalKey ?? alias;
  const restrictToSpawned =
    params.sandboxed === true &&
    visibility === "spawned" &&
    !!requesterInternalKey &&
    !isSubagentSessionKey(requesterInternalKey);
  return {
    mainKey,
    alias,
    visibility,
    requesterInternalKey,
    effectiveRequesterKey,
    restrictToSpawned,
  };
}
