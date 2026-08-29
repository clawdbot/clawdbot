import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentConfig } from "../agents/agent-scope.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import {
  resolveReasoningDefault,
  shouldUseModelReasoningDefault,
} from "../agents/model-selection.js";
import { resolveConfiguredThinkingDefaultCore } from "../agents/model-thinking-default-core.js";
import { normalizeReasoningLevel } from "../auto-reply/thinking.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

type GatewaySessionReasoningProjectionParams = {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  agentId: string;
  entry?: SessionEntry;
  modelCatalog?: ModelCatalogEntry[];
  effectiveThinkingLevel: string;
};

export function resolveGatewaySessionReasoningLevel(
  params: GatewaySessionReasoningProjectionParams,
): string | undefined {
  const storedReasoningLevel = normalizeOptionalString(params.entry?.reasoningLevel);
  const agentConfig = resolveAgentConfig(params.cfg, params.agentId);
  const configuredReasoningDefault = normalizeReasoningLevel(
    agentConfig?.reasoningDefault ?? params.cfg.agents?.defaults?.reasoningDefault,
  );
  const thinkingExplicitlySet =
    params.entry?.thinkingLevel !== undefined ||
    agentConfig?.thinkingDefault !== undefined ||
    resolveConfiguredThinkingDefaultCore(params) !== undefined;
  const projectedReasoningLevel =
    (storedReasoningLevel
      ? (normalizeReasoningLevel(storedReasoningLevel) ?? storedReasoningLevel)
      : undefined) ??
    configuredReasoningDefault ??
    "off";
  const reasoningExplicitlySet =
    storedReasoningLevel !== undefined || configuredReasoningDefault !== undefined;
  // Without a catalog, an unowned reasoning default stays unknown even when a
  // model-family fallback enables thinking. Do not project a destructive "off".
  if (!reasoningExplicitlySet && !thinkingExplicitlySet && params.modelCatalog === undefined) {
    return undefined;
  }
  const usesModelReasoningDefault = shouldUseModelReasoningDefault({
    reasoningExplicitlySet,
    resolvedReasoningLevel: projectedReasoningLevel,
    thinkingActive: params.effectiveThinkingLevel !== "off",
    thinkingExplicitlySet,
  });
  // A catalog-less event cannot determine whether the selected model supports
  // reasoning. Omit the derived value so it cannot overwrite a richer client row.
  if (usesModelReasoningDefault && params.modelCatalog === undefined) {
    return undefined;
  }
  return usesModelReasoningDefault
    ? resolveReasoningDefault({
        provider: params.provider,
        model: params.model,
        catalog: params.modelCatalog,
      })
    : projectedReasoningLevel;
}
