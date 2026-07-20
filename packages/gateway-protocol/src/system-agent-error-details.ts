/** Structured system-agent details carried in gateway error payloads. */
export const SystemAgentErrorDetailCodes = {
  SESSION_INVALIDATED: "system_agent_session_invalidated",
} as const;

export type SystemAgentSessionInvalidatedErrorDetails = {
  code: typeof SystemAgentErrorDetailCodes.SESSION_INVALIDATED;
};

export function buildSystemAgentSessionInvalidatedErrorDetails(): SystemAgentSessionInvalidatedErrorDetails {
  return { code: SystemAgentErrorDetailCodes.SESSION_INVALIDATED };
}

export function readSystemAgentSessionInvalidatedErrorDetails(
  details: unknown,
): SystemAgentSessionInvalidatedErrorDetails | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return undefined;
  }
  const code = (details as { code?: unknown }).code;
  return code === SystemAgentErrorDetailCodes.SESSION_INVALIDATED ? { code } : undefined;
}
