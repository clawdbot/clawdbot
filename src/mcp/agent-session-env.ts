import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { isValidExactModelPolicyRef } from "../config/model-policy-ref.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";

export const OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY_ENV = "OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY";
const TOOLS_MCP_MODEL_REF_ARG = "--openclaw-model-ref";

function resolveToolsMcpArg(argv: readonly string[], option: string): string | undefined {
  const index = argv.indexOf(option);
  if (index < 0) {
    return undefined;
  }
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith("--") || argv.includes(option, index + 1)) {
    throw new Error(`${option} requires one value`);
  }
  return value;
}

/** Private generated-helper argv selects context, never approval or execution authority. */
export function resolveToolsMcpAgentId(
  argv: readonly string[] = process.argv.slice(2),
): string | undefined {
  const agentId = resolveToolsMcpArg(argv, "--openclaw-agent-id");
  return agentId ? normalizeAgentId(agentId) : undefined;
}

export function resolveToolsMcpSessionContext(params: {
  agentSessionKey?: string;
  agentId?: string;
}): { sessionKey?: string; agentId?: string } {
  const sessionKey = (params.agentSessionKey ?? resolveToolsMcpAgentSessionKey())?.trim();
  const encodedOwner = sessionKey ? parseAgentSessionKey(sessionKey)?.agentId : undefined;
  const agentId = params.agentId?.trim() ? normalizeAgentId(params.agentId) : encodedOwner;
  if (
    (sessionKey && !agentId) ||
    (encodedOwner && encodedOwner !== agentId) ||
    (!sessionKey && agentId)
  ) {
    throw new Error(
      `${OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY_ENV} must be a canonical agent session key or have a matching explicit OpenClaw owner`,
    );
  }
  return sessionKey ? { sessionKey, agentId } : {};
}

export function resolveToolsMcpAgentSessionKey(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env[OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY_ENV]?.trim() || undefined;
}

export function resolveToolsMcpModelRef(
  argv: readonly string[] = process.argv.slice(2),
): string | undefined {
  return resolveToolsMcpArg(argv, TOOLS_MCP_MODEL_REF_ARG);
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
