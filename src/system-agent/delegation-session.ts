// Binds delegated chat state to its requesting agent session.
export function resolveSystemAgentDelegationKey(
  delegation:
    | {
        agentId?: string;
        sessionKey?: string;
      }
    | undefined,
): string | undefined {
  return delegation
    ? JSON.stringify([delegation.agentId ?? null, delegation.sessionKey ?? null])
    : undefined;
}
