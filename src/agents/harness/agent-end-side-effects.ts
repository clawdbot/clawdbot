/**
 * Agent-end side effect runner.
 *
 * Harnesses use this to trigger core research capture and plugin agent_end hooks
 * either fire-and-forget or awaited during tests/shutdown.
 */
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runSkillResearchAutoCapture } from "../../skills/research/autocapture.js";
import {
  awaitAgentHarnessAgentEndHook,
  runAgentHarnessAgentEndHook,
} from "./lifecycle-hook-helpers.js";

const log = createSubsystemLogger("agents/harness");

type AgentEndSideEffectsParams = Parameters<typeof runAgentHarnessAgentEndHook>[0];

async function runCoreAgentEndSideEffects(params: AgentEndSideEffectsParams): Promise<void> {
  try {
    await runSkillResearchAutoCapture({
      event: params.event,
      ctx: params.ctx,
      ...(params.ctx.config ? { config: params.ctx.config } : {}),
    });
  } catch (error) {
    // Side effects are observational; failures must not change the completed run result.
    log.warn(`skill research auto-capture failed: ${String(error)}`);
  }
}

/** Starts agent-end side effects without waiting for completion. */
export function runAgentEndSideEffects(params: AgentEndSideEffectsParams): void {
  void runCoreAgentEndSideEffects(params);
  runAgentHarnessAgentEndHook(params);
}

/** Runs agent-end side effects and waits for plugin/core completion. */
export async function awaitAgentEndSideEffects(params: AgentEndSideEffectsParams): Promise<void> {
  await runCoreAgentEndSideEffects(params);
  await awaitAgentHarnessAgentEndHook(params);
}
