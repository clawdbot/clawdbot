/**
 * Agent-end side effect runner.
 *
 * Harnesses use this to trigger skill experience review and plugin agent_end hooks
 * either fire-and-forget or awaited during tests/shutdown.
 */
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { consumeRunSkillUsage } from "../../skills/runtime/run-usage.js";
import type { EmbeddedForegroundPromptContext } from "../embedded-agent-runner/run/params.js";
import {
  awaitAgentHarnessAgentEndHook,
  runAgentHarnessAgentEndHook,
} from "./lifecycle-hook-helpers.js";

const log = createSubsystemLogger("agents/harness");

type BaseAgentEndSideEffectsParams = Parameters<typeof runAgentHarnessAgentEndHook>[0];
type AgentEndSideEffectsParams = Omit<BaseAgentEndSideEffectsParams, "ctx"> & {
  ctx: BaseAgentEndSideEffectsParams["ctx"] & {
    authProfileId?: string;
    modelIterations?: number;
    modelContextWindowTokens?: number;
    skillWorkshopAvailable?: boolean;
    compacted?: boolean;
    foregroundPromptContext?: EmbeddedForegroundPromptContext;
  };
};

async function runCoreAgentEndSideEffects(params: AgentEndSideEffectsParams): Promise<void> {
  const usedSkills = consumeRunSkillUsage(params.ctx.runId);
  // CLI hook contexts omit skillWorkshopAvailable, so isEligibleContext rejects them.
  if (!params.ctx.foregroundPromptContext) {
    return;
  }
  if (!params.ctx.config) {
    return;
  }
  const ctx = { ...params.ctx, foregroundPromptContext: params.ctx.foregroundPromptContext };
  try {
    const { scheduleSkillExperienceReview } =
      await import("../../skills/workshop/experience-review-default.js");
    scheduleSkillExperienceReview({
      event: params.event,
      ctx,
      usedSkills,
      config: params.ctx.config,
    });
  } catch (error) {
    // Side effects are observational; failures must not change the completed run result.
    log.warn(`skill experience review scheduling failed: ${String(error)}`);
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
