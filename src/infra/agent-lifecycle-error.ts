const AGENT_RUN_STALE_LIFECYCLE_ERROR = "Agent run belongs to a stale gateway lifecycle";
const AGENT_RUN_STALE_LIFECYCLE_ERROR_CODE = "ERR_STALE_GATEWAY_LIFECYCLE";

export function createAgentRunStaleLifecycleError(): Error {
  const error = new Error(AGENT_RUN_STALE_LIFECYCLE_ERROR) as Error & { code: string };
  error.name = "AbortError";
  error.code = AGENT_RUN_STALE_LIFECYCLE_ERROR_CODE;
  return error;
}

export function isAgentRunStaleLifecycleError(value: unknown): boolean {
  try {
    return (
      value instanceof Error &&
      "code" in value &&
      value.code === AGENT_RUN_STALE_LIFECYCLE_ERROR_CODE
    );
  } catch {
    return false;
  }
}
