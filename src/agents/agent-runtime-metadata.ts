/** Resolves agent runtime metadata from model/provider policy and ACP session overlays. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyAcpRuntimeOverlay, type AgentRuntimeMetadata } from "./acp-runtime-overlay.js";
import { isDefaultAgentRuntimeId } from "./agent-runtime-id.js";
import { resolveAvailableAgentHarnessPolicy } from "./harness/availability.js";
import { resolveDefaultModelForAgent } from "./model-selection.js";
import {
  resolvePersistedSessionRuntimeId,
  resolveSessionRuntimeOverrideForProvider,
} from "./session-runtime-compat.js";

type ModelAgentRuntimeMetadataParams = {
  cfg: OpenClawConfig;
  agentId: string;
  provider?: string;
  model?: string;
  sessionKey?: string;
  sessionEntry?: Parameters<typeof resolvePersistedSessionRuntimeId>[0];
  /** True only when persisted ACP metadata owns the session. */
  acpRuntime?: boolean;
  /** Persisted ACP backend id, falling back to acpx when absent. */
  acpBackend?: string;
  agentHarnessRuntimeOverride?: string;
};

/** Resolves the runtime id/source that should be reported for a model-backed agent session. */
export function resolveModelAgentRuntimeMetadata(
  params: ModelAgentRuntimeMetadataParams,
): AgentRuntimeMetadata {
  const persistedRuntimeId = resolvePersistedSessionRuntimeId(params.sessionEntry);
  if (persistedRuntimeId && !isDefaultAgentRuntimeId(persistedRuntimeId)) {
    return applyAcpRuntimeOverlay(
      { id: persistedRuntimeId, source: "session" },
      params.sessionKey,
      params.acpRuntime,
      params.acpBackend,
    );
  }
  const resolved =
    params.provider && params.model
      ? { provider: params.provider, model: params.model }
      : resolveDefaultModelForAgent({ cfg: params.cfg, agentId: params.agentId });
  const policy = resolveAvailableAgentHarnessPolicy({
    mode: "projection",
    provider: resolved.provider,
    modelId: resolved.model,
    config: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    agentHarnessRuntimeOverride: params.agentHarnessRuntimeOverride,
  });
  const meta: AgentRuntimeMetadata = {
    id: policy.runtime,
    source: policy.runtimeSource ?? "implicit",
  };
  return applyAcpRuntimeOverlay(meta, params.sessionKey, params.acpRuntime, params.acpBackend);
}

/** Resolves the runtime selected for the next turn, excluding historical producer metadata. */
export function resolveCurrentSessionAgentRuntimeMetadata(
  params: ModelAgentRuntimeMetadataParams,
): AgentRuntimeMetadata {
  const { sessionEntry, ...configuredParams } = params;
  const sessionRuntime = resolveSessionRuntimeOverrideForProvider({
    provider: params.provider,
    entry: sessionEntry,
    cfg: params.cfg,
  });
  if (params.acpRuntime || !sessionRuntime) {
    return resolveModelAgentRuntimeMetadata(configuredParams);
  }
  const runtime = resolveModelAgentRuntimeMetadata({
    ...configuredParams,
    ...(sessionEntry?.modelSelectionLocked === true
      ? { sessionEntry }
      : { agentHarnessRuntimeOverride: sessionRuntime }),
  });
  return {
    id: runtime.id,
    source: sessionEntry?.modelSelectionLocked === true ? "session" : "session-key",
  };
}
