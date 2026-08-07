import type { RunCliAgentParams } from "./types.js";

/** Projects admitted execution identity over legacy flat CLI-run fields. */
export function bindCliRunExecutionAttribution(params: RunCliAgentParams): RunCliAgentParams {
  const attribution = params.attribution;
  if (!attribution) {
    return params;
  }
  const {
    runId: _legacyRunId,
    lifecycleGeneration: _legacyLifecycleGeneration,
    sessionKey: _legacySessionKey,
    sessionId: _legacySessionId,
    agentId: _legacyAgentId,
    ...run
  } = params;
  return {
    ...run,
    runId: attribution.runId,
    lifecycleGeneration: attribution.lifecycleGeneration,
    sessionId: attribution.sessionId ?? _legacySessionId,
    // Optional attribution fields are audit facts. When they are absent, keep
    // the CLI candidate's operational routing instead of selecting a default.
    ...((attribution.sessionKey ?? _legacySessionKey)
      ? { sessionKey: attribution.sessionKey ?? _legacySessionKey }
      : {}),
    ...((attribution.agentId ?? _legacyAgentId)
      ? { agentId: attribution.agentId ?? _legacyAgentId }
      : {}),
  };
}
