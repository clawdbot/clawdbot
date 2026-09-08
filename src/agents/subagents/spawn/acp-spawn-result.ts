export type SpawnAcpMode = "run" | "session";

const ACP_SPAWN_ERROR_CODES = [
  "acp_disabled",
  "requester_session_required",
  "runtime_policy",
  "resume_forbidden",
  "subagent_policy",
  "thread_required",
  "target_agent_required",
  "runtime_agent_mismatch",
  "agent_forbidden",
  "cwd_resolution_failed",
  "thread_binding_invalid",
  "spawn_failed",
  "dispatch_failed",
] as const;

type SpawnAcpResultFields = {
  childSessionKey?: string;
  runId?: string;
  mode?: SpawnAcpMode;
  runTimeoutSeconds?: number;
  expectsCompletionMessage?: boolean;
  inlineDelivery?: boolean;
  note?: string;
};

type SpawnAcpErrorCode = (typeof ACP_SPAWN_ERROR_CODES)[number];

export type SpawnAcpResult =
  | (SpawnAcpResultFields & {
      status: "accepted";
      childSessionKey: string;
      runId: string;
      mode: SpawnAcpMode;
    })
  | (SpawnAcpResultFields & {
      status: "forbidden" | "error";
      error: string;
      errorCode: SpawnAcpErrorCode;
    });

export function createAcpSpawnFailure(params: {
  status: "forbidden" | "error";
  errorCode: SpawnAcpErrorCode;
  error: string;
  childSessionKey?: string;
  runId?: string;
}): SpawnAcpResult {
  return {
    status: params.status,
    errorCode: params.errorCode,
    error: params.error,
    ...(params.childSessionKey ? { childSessionKey: params.childSessionKey } : {}),
    ...(params.runId ? { runId: params.runId } : {}),
  };
}
