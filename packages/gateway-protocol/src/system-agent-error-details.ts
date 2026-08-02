/** Structured system-agent details carried in gateway error payloads. */
export const SystemAgentErrorDetailCodes = {
  INFERENCE_UNAVAILABLE: "system_agent_inference_unavailable",
  SESSION_INVALIDATED: "system_agent_session_invalidated",
} as const;

export type SystemAgentInferenceUnavailableErrorDetails = {
  code: typeof SystemAgentErrorDetailCodes.INFERENCE_UNAVAILABLE;
};

export type SystemAgentSessionInvalidatedErrorDetails = {
  code: typeof SystemAgentErrorDetailCodes.SESSION_INVALIDATED;
};

export function buildSystemAgentInferenceUnavailableErrorDetails(): SystemAgentInferenceUnavailableErrorDetails {
  return { code: SystemAgentErrorDetailCodes.INFERENCE_UNAVAILABLE };
}

export function buildSystemAgentSessionInvalidatedErrorDetails(): SystemAgentSessionInvalidatedErrorDetails {
  return { code: SystemAgentErrorDetailCodes.SESSION_INVALIDATED };
}

export function readSystemAgentInferenceUnavailableErrorDetails(
  details: unknown,
): SystemAgentInferenceUnavailableErrorDetails | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return undefined;
  }
  const code = (details as { code?: unknown }).code;
  return code === SystemAgentErrorDetailCodes.INFERENCE_UNAVAILABLE ? { code } : undefined;
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
