import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyAcpRuntimeOverlay, type AgentRuntimeMetadata } from "./acp-runtime-overlay.js";
import { resolveAgentHarnessPolicy } from "./harness/policy.js";
import { resolveDefaultModelForAgent } from "./model-selection.js";

export type { AgentRuntimeMetadata };

export function resolveAgentRuntimeMetadata(
  _cfg: OpenClawConfig,
  _agentId: string,
  _env: NodeJS.ProcessEnv = process.env,
): AgentRuntimeMetadata {
  return {
    id: "auto",
    source: "implicit",
  };
}

export function resolveModelAgentRuntimeMetadata(params: {
  cfg: OpenClawConfig;
  agentId: string;
  provider?: string;
  model?: string;
  sessionKey?: string;
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
