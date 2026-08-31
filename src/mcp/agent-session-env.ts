import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { isValidExactModelPolicyRef } from "../config/model-policy-ref.js";

export const OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY_ENV = "OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY";
export const OPENCLAW_TOOLS_MCP_MODEL_REF_ENV = "OPENCLAW_TOOLS_MCP_MODEL_REF";

export function resolveToolsMcpAgentSessionKey(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env[OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY_ENV]?.trim() || undefined;
}

export function resolveToolsMcpModelRef(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[OPENCLAW_TOOLS_MCP_MODEL_REF_ENV]?.trim() || undefined;
}

export function parseToolsMcpModelRef(
  raw: string | undefined,
): { provider: string; modelId?: string } | undefined {
  const modelRef = raw?.trim();
  if (!modelRef) {
    return undefined;
  }
  if (!modelRef.includes("/")) {
    if (!isValidExactModelPolicyRef(`${modelRef}/model`)) {
      return undefined;
    }
    return { provider: modelRef };
  }
  if (!isValidExactModelPolicyRef(modelRef)) {
    return undefined;
  }
  const parsed = parseModelCatalogRef(modelRef);
  if (!parsed) {
    return undefined;
  }
  return {
    provider: parsed.provider,
    modelId: parsed.modelId,
  };
}
