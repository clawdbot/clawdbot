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
): { provider: string; modelId: string } | undefined {
  const modelRef = raw?.trim();
  const separator = modelRef?.indexOf("/") ?? -1;
  if (!modelRef || separator <= 0 || separator === modelRef.length - 1) {
    return undefined;
  }
  return {
    provider: modelRef.slice(0, separator),
    modelId: modelRef.slice(separator + 1),
  };
}
