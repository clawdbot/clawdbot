import type { ChatType } from "../../channels/chat-type.js";
/**
 * Agent-end side effect runner.
 *
 * Harnesses use this to trigger core research capture and plugin agent_end hooks
 * either fire-and-forget or awaited during tests/shutdown.
 */
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  awaitAgentHarnessAgentEndHook,
  runAgentHarnessAgentEndHook,
} from "./lifecycle-hook-helpers.js";

const log = createSubsystemLogger("agents/harness");

type BaseAgentEndSideEffectsParams = Parameters<typeof runAgentHarnessAgentEndHook>[0];
type AgentEndSideEffectsParams = Omit<BaseAgentEndSideEffectsParams, "ctx"> & {
  ctx: BaseAgentEndSideEffectsParams["ctx"] & {
    authProfileId?: string;
    skillWorkshopAvailable?: boolean;
    compacted?: boolean;
    messageChannel?: string | null;
    chatType?: ChatType;
    agentAccountId?: string | null;
    groupId?: string | null;
    groupChannel?: string | null;
    groupSpace?: string | null;
    memberRoleIds?: readonly string[];
    spawnedBy?: string | null;
    senderName?: string | null;
    senderUsername?: string | null;
    senderE164?: string | null;
    senderIsOwner?: boolean;
  };
};

async function runCoreAgentEndSideEffects(params: AgentEndSideEffectsParams): Promise<void> {
  try {
    const { scheduleSkillExperienceReview } =
      await import("../../skills/workshop/experience-review-default.js");
    scheduleSkillExperienceReview({
      event: params.event,
      ctx: params.ctx,
      ...(params.ctx.config ? { config: params.ctx.config } : {}),
    });
  } catch (error) {
    // Side effects are observational; failures must not change the completed run result.
    log.warn(`skill experience review scheduling failed: ${String(error)}`);
  }
  try {
    const { runSkillResearchAutoCapture } = await import("../../skills/research/autocapture.js");
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
