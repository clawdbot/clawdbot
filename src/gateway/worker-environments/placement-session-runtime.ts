import {
  isDefaultAgentRuntimeId,
  OPENCLAW_AGENT_RUNTIME_ID,
} from "../../agents/agent-runtime-id.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import { resolvePersistedSessionRuntimeId } from "../../agents/session-runtime-compat.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export function resolveWorkerPlacementSessionRuntime(params: {
  cfg: OpenClawConfig;
  entry: SessionEntry;
  agentId: string;
  sessionKey: string;
}): string {
  const persistedRuntime = resolvePersistedSessionRuntimeId(params.entry);
  if (persistedRuntime && !isDefaultAgentRuntimeId(persistedRuntime)) {
    return persistedRuntime;
  }
  const selectedModel = resolveSessionModelRef(params.cfg, params.entry, params.agentId);
  return resolveEffectiveAgentRuntime({
    cfg: params.cfg,
    provider: selectedModel.provider,
    modelId: selectedModel.model,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
}

export function isWorkerPlacementSessionRuntimeSupported(runtime: string): boolean {
  return runtime === OPENCLAW_AGENT_RUNTIME_ID;
}
