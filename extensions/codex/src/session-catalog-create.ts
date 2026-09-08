import { resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";

const CODEX_AGENT_RUNTIME_ID = "codex";
const CODEX_CATALOG_DEFAULT_MODEL_REF = "openai/gpt-5.6-sol";

export function resolveCodexCatalogCreateSession(
  modelConfig: Pick<
    PluginRuntime["modelConfig"],
    "resolveAllowedModelRef" | "resolveDefaultModelForAgent"
  >,
  config: OpenClawConfig | undefined,
  requestedAgentId?: string,
): { model: string; agentRuntime: string } | undefined {
  if (!config) {
    return undefined;
  }
  const agentId = requestedAgentId ?? resolveDefaultAgentId(config);
  const defaultModel = modelConfig.resolveDefaultModelForAgent({ cfg: config, agentId });
  const allowed = modelConfig.resolveAllowedModelRef({
    cfg: config,
    catalog: [],
    raw: CODEX_CATALOG_DEFAULT_MODEL_REF,
    defaultProvider: defaultModel.provider,
    defaultModel: defaultModel.model,
    agentId,
  });
  return "error" in allowed
    ? undefined
    : { model: CODEX_CATALOG_DEFAULT_MODEL_REF, agentRuntime: CODEX_AGENT_RUNTIME_ID };
}
