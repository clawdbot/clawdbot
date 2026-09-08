import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeOptionalAgentRuntimeId } from "../agents/agent-runtime-id.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { inheritSessionSelection } from "../config/sessions/session-entry-selection.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewaySessionTitleModelSelection } from "./session-lifecycle-preparation.js";
import { resolveSessionPatchModelSelection } from "./sessions-patch.js";

export function resolveSessionCreateModelSelection(
  cfg: OpenClawConfig,
  agentId: string,
  input: string | { model: string; agentRuntime?: string } | undefined,
  parentEntry?: SessionEntry,
): GatewaySessionTitleModelSelection | null {
  const model = normalizeOptionalString(typeof input === "string" ? input : input?.model);
  if (!model) {
    const inherited = inheritSessionSelection(parentEntry);
    return {
      providerOverride: inherited.providerOverride,
      modelOverride: inherited.modelOverride,
      agentRuntimeOverride: inherited.agentRuntimeOverride,
      authProfileOverride: inherited.authProfileOverride,
    };
  }
  const defaults = resolveDefaultModelForAgent({ cfg, agentId });
  // Reuse patch policy with the config-owned catalog projection. Persisted creation
  // remains the sole live-catalog availability validator.
  const resolved = resolveSessionPatchModelSelection({
    cfg,
    agentId,
    catalog: [],
    raw: model,
    defaultProvider: defaults.provider,
    defaultModel: defaults.model,
  });
  if (!resolved.ok) {
    return null;
  }
  const agentRuntimeOverride = normalizeOptionalAgentRuntimeId(
    typeof input === "string" ? undefined : input?.agentRuntime,
  );
  return {
    providerOverride: resolved.provider,
    modelOverride: resolved.model,
    ...(agentRuntimeOverride ? { agentRuntimeOverride } : {}),
    ...(resolved.profile ? { authProfileOverride: resolved.profile } : {}),
  };
}
