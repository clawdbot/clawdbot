/** Resolves agent runtime metadata from model/provider policy and ACP session overlays. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyAcpRuntimeOverlay, type AgentRuntimeMetadata } from "./acp-runtime-overlay.js";
import { isDefaultAgentRuntimeId } from "./agent-runtime-id.js";
import { resolveAgentHarnessPolicy } from "./harness/policy.js";
import { resolveDefaultModelForAgent } from "./model-selection.js";
import {
  resolvePersistedSessionRuntimeId,
  resolveSessionRuntimeOverrideForProvider,
} from "./session-runtime-compat.js";

/** Resolves the runtime id/source that should be reported for a model-backed agent session. */
export function resolveModelAgentRuntimeMetadata(params: {
  cfg: OpenClawConfig;
  agentId: string;
  provider?: string;
  model?: string;
  sessionKey?: string;
  sessionEntry?: Parameters<typeof resolvePersistedSessionRuntimeId>[0];
  /**
   * True when the loaded session entry has persisted ACP metadata. ACP-shaped
   * keys without this marker can be bridge sessions that use the configured
   * model/runtime.
   */
  acpRuntime?: boolean;
  /**
   * The ACP backend identifier stored on the session entry (`entry.acp.backend`).
   * When provided for an ACP-keyed session, the overlay reports this value as the
   * runtime id instead of the generic fallback "acpx", so sessions backed by a
   * non-default registered ACP backend are classified correctly.
   */
  acpBackend?: string;
}): AgentRuntimeMetadata {
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
  const policy = resolveAgentHarnessPolicy({
    provider: resolved.provider,
    modelId: resolved.model,
    config: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  const meta: AgentRuntimeMetadata = {
    id: policy.runtime,
    source: policy.runtimeSource ?? "implicit",
  };
  return applyAcpRuntimeOverlay(meta, params.sessionKey, params.acpRuntime, params.acpBackend);
}

/** Resolves the runtime that would handle the next turn for an existing session. */
export function resolveEffectiveSessionAgentRuntimeMetadata(
  params: Parameters<typeof resolveModelAgentRuntimeMetadata>[0],
): AgentRuntimeMetadata {
  const configured = resolveModelAgentRuntimeMetadata({
    ...params,
    sessionEntry: undefined,
  });
  const persistedRuntime = resolveSessionRuntimeOverrideForProvider({
    provider: params.provider,
    entry: params.sessionEntry,
    cfg: params.cfg,
  });
  if (params.acpRuntime || !persistedRuntime) {
    return configured;
  }
  return {
    id: persistedRuntime,
    source: params.sessionEntry?.modelSelectionLocked === true ? "session" : "session-key",
  };
}
