/**
 * Tool loop-detection config resolver.
 * Overlays per-agent loop detection settings on global defaults while
 * preserving the per-agent enabled override.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import { resolveAgentConfig } from "./agent-scope.js";

/** Effective runLoop guard values for an agent-core Agent. `undefined` disables a guard. */
export type LoopGuardRuntimeConfig = {
  maxTurns: number | undefined;
  maxConsecutiveErrorBatches: number | undefined;
  maxIdleRepeatCalls: number | undefined;
};

/** Resolves effective tool loop-detection config by overlaying agent settings on globals. */
export function resolveToolLoopDetectionConfig(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): ToolLoopDetectionConfig | undefined {
  const global = params.cfg?.tools?.loopDetection;
  const agent =
    params.agentId && params.cfg
      ? resolveAgentConfig(params.cfg, params.agentId)?.tools?.loopDetection
      : undefined;

  if (!agent) {
    return global;
  }
  if (!global) {
    return agent;
  }

  return {
    enabled: agent.enabled ?? global.enabled,
    turnLimit: agent.turnLimit ?? global.turnLimit,
    maxConsecutiveErrorBatches:
      agent.maxConsecutiveErrorBatches ?? global.maxConsecutiveErrorBatches,
    maxIdleRepeatCalls: agent.maxIdleRepeatCalls ?? global.maxIdleRepeatCalls,
  };
}

/**
 * Resolves the runLoop guard values for a runtime-created agent.
 *
 * The runLoop guards are opt-in and separate from the rolling-history
 * `enabled` switch: `enabled: true` activates the existing rolling-history
 * detectors (pre-guard behavior), but does NOT automatically engage the
 * runLoop hard cutoffs. Each guard activates independently when its key
 * (`turnLimit`, `maxConsecutiveErrorBatches`, `maxIdleRepeatCalls`) is
 * explicitly set to a positive integer; the configured value is the cutoff.
 * This preserves the upgrade contract: an existing
 * `tools.loopDetection: { enabled: true }` configuration gains no new hard
 * termination behavior unless the operator explicitly sets a guard key.
 * `enabled: false` disables both layers.
 */
export function resolveLoopGuardRuntimeConfig(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): LoopGuardRuntimeConfig {
  const loopDetection = resolveToolLoopDetectionConfig(params);
  if (loopDetection === undefined || loopDetection.enabled === false) {
    return {
      maxTurns: undefined,
      maxConsecutiveErrorBatches: undefined,
      maxIdleRepeatCalls: undefined,
    };
  }
  return {
    maxTurns: loopDetection.turnLimit,
    maxConsecutiveErrorBatches: loopDetection.maxConsecutiveErrorBatches,
    maxIdleRepeatCalls: loopDetection.maxIdleRepeatCalls,
  };
}
