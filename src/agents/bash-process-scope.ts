/** Resolve the process-tool isolation key for exec/process session state. */
export function resolveProcessToolScopeKey(params: {
  scopeKey?: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
}): string | undefined {
  const explicitScopeKey = params.scopeKey?.trim();
  if (explicitScopeKey) {
    return explicitScopeKey;
  }
  const sessionKey = params.sessionKey?.trim();
  if (sessionKey) {
    return sessionKey;
  }
  const sessionId = params.sessionId?.trim();
  if (sessionId) {
    return sessionId;
  }
  const agentId = params.agentId?.trim();
  return agentId ? `agent:${agentId}` : undefined;
}
