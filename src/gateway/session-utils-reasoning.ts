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
): string {
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
  return shouldUseModelReasoningDefault({
    reasoningExplicitlySet:
      storedReasoningLevel !== undefined || configuredReasoningDefault !== undefined,
    resolvedReasoningLevel: projectedReasoningLevel,
    thinkingActive: params.effectiveThinkingLevel !== "off",
    thinkingExplicitlySet,
  })
    ? resolveReasoningDefault({
        provider: params.provider,
        model: params.model,
        catalog: params.modelCatalog,
      })
    : projectedReasoningLevel;
}
