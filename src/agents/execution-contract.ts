import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { resolveAgentExecutionContract, resolveSessionAgentIds } from "./agent-scope.js";

export function isStrictAgenticExecutionContractActive(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  agentId?: string | null;
  provider?: string | null;
  modelId?: string | null;
}): boolean {
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId ?? undefined,
  });
  if (resolveAgentExecutionContract(params.config, sessionAgentId) !== "strict-agentic") {
    return false;
  }
  const provider = normalizeLowercaseStringOrEmpty(params.provider ?? "");
  if (provider !== "openai" && provider !== "openai-codex") {
    return false;
  }
  return /^gpt-5(?:[.-]|$)/i.test(params.modelId?.trim() ?? "");
}
