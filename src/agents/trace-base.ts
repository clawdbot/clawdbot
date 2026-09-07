/**
 * Common trace fields copied into provider/model diagnostic events. Keeping the
 * shape small makes telemetry payloads stable across provider paths.
 */
type AgentTraceBase = {
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  workspaceDir?: string;
};

/** Build a trace base object while preserving undefined optional fields. */
export function buildAgentTraceBase(params: AgentTraceBase): AgentTraceBase {
  return {
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    provider: params.provider,
    modelId: params.modelId,
    modelApi: params.modelApi,
    workspaceDir: params.workspaceDir,
  };
}
