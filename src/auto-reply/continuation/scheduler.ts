/**
 * Continuation budget helpers.
 *
 * Delayed delegate scheduling is TaskFlow-backed via delegate-store and
 * delegate-dispatch; this module only owns the shared cap checks.
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ChainState, ContinuationRuntimeConfig } from "./types.js";

const log = createSubsystemLogger("continuation/scheduler");

export type { ChainState } from "./types.js";

/**
 * Check chain and cost caps. Returns null if clear to proceed, or the
 * rejection reason.
 */
export function checkContinuationBudget(params: {
  chainState: ChainState;
  config: ContinuationRuntimeConfig;
  sessionKey: string;
}): "chain-capped" | "cost-capped" | null {
  const { chainState, config, sessionKey } = params;
  const allocatedChainHop = chainState.currentChainCount;

  if (allocatedChainHop >= config.maxChainLength) {
    log.info(
      `[continuation] Chain depth ${allocatedChainHop}/${config.maxChainLength} — capped for session ${sessionKey}`,
    );
    return "chain-capped";
  }

  if (config.costCapTokens > 0 && chainState.accumulatedChainTokens > config.costCapTokens) {
    log.info(
      `[continuation] Chain cost ${chainState.accumulatedChainTokens}/${config.costCapTokens} — capped for session ${sessionKey}`,
    );
    return "cost-capped";
  }

  return null;
}
