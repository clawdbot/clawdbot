/**
 * Reads configured embedded-run model fallback availability.
 */
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { hasConfiguredModelFallbacks } from "../../agent-scope.js";

/**
 * Resolves whether this embedded run has any model fallback path available.
 * Per-run overrides are authoritative so compaction/replay callers can force
 * either a fallback lane or a no-fallback lane independent of agent defaults.
 */
export function hasEmbeddedRunConfiguredModelFallbacks(params: {
  cfg: OpenClawConfig | undefined;
  agentId?: string | null;
  sessionKey?: string | null;
  modelFallbacksOverride?: string[];
}): boolean {
  // An explicit empty override disables fallbacks even when config has defaults.
  if (params.modelFallbacksOverride !== undefined) {
    return params.modelFallbacksOverride.length > 0;
  }
  return hasConfiguredModelFallbacks({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
}
