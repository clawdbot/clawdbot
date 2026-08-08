import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  resolveAllowedModelRef,
  resolveDefaultModelForAgent,
} from "../../agents/model-selection.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SessionCatalogCreateTarget } from "../session-catalog.js";

type RuntimeSessionCatalogCreateTargetParams = {
  config: OpenClawConfig;
  requestedAgentId?: string;
  provider: string;
  modelIds: readonly string[];
  agentRuntime: string;
};

/**
 * Resolve a synchronous catalog create target through the same model/runtime
 * policy used by agent turns, without making plugins import that policy graph.
 */
export function resolveSessionCatalogCreateTarget(
  params: RuntimeSessionCatalogCreateTargetParams,
): SessionCatalogCreateTarget | undefined {
  const agentId = params.requestedAgentId ?? resolveDefaultAgentId(params.config);
  const defaultModel = resolveDefaultModelForAgent({ cfg: params.config, agentId });
  for (const modelId of params.modelIds) {
    if (
      resolveEffectiveAgentRuntime({
        cfg: params.config,
        provider: params.provider,
        modelId,
        agentId,
      }) !== params.agentRuntime
    ) {
      continue;
    }
    const model = `${params.provider}/${modelId}`;
    const allowed = resolveAllowedModelRef({
      cfg: params.config,
      catalog: [],
      raw: model,
      defaultProvider: defaultModel.provider,
      defaultModel: defaultModel.model,
      agentId,
    });
    if (!("error" in allowed)) {
      return { model, agentRuntime: params.agentRuntime };
    }
  }
  return undefined;
}
