/**
 * Agent-end side effect runner.
 *
 * Harnesses use this to trigger skill experience review and plugin agent_end hooks
 * either fire-and-forget or awaited during tests/shutdown.
 */
import { getRuntimeConfig } from "../../config/config.js";
import { readActiveTranscriptEntryAnchor } from "../../config/sessions/session-accessor.sqlite-transcript-anchor.js";
import type { TranscriptEntryAnchor } from "../../config/sessions/transcript-entry-anchor.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { consumeRunSkillUsage } from "../../skills/runtime/run-usage.js";
import { scheduleSkillExperienceReview } from "../../skills/workshop/experience-review-default.js";
import type { EmbeddedForegroundPromptContext } from "../embedded-agent-runner/run/params.js";
import {
  awaitAgentHarnessAgentEndHook,
  runAgentHarnessAgentEndHook,
} from "./lifecycle-hook-helpers.js";

const log = createSubsystemLogger("agents/harness");

type BaseAgentEndSideEffectsParams = Parameters<typeof runAgentHarnessAgentEndHook>[0];
type AgentEndSideEffectsParams = Omit<BaseAgentEndSideEffectsParams, "ctx"> & {
  /** Exact completed-turn boundary; context loading stays off the foreground path. */
  skillExperienceReviewSource?: Pick<
    TranscriptEntryAnchor,
    "agentId" | "sessionId" | "sessionKey" | "storePath" | "entryId"
  >;
  ctx: BaseAgentEndSideEffectsParams["ctx"] & {
    authProfileId?: string;
    modelIterations?: number;
    modelContextWindowTokens?: number;
    skillWorkshopAvailable?: boolean;
    compacted?: boolean;
    foregroundPromptContext?: EmbeddedForegroundPromptContext;
  };
};

function runCoreAgentEndSideEffects(params: AgentEndSideEffectsParams): void {
  const usedSkills = consumeRunSkillUsage(params.ctx.runId);
  // CLI hook contexts omit skillWorkshopAvailable, so isEligibleContext rejects them.
  const source = params.skillExperienceReviewSource;
  if (!params.ctx.foregroundPromptContext || !source) {
    return;
  }
  // Hook contexts do not always carry the config; the runtime config is the owner at this boundary.
  const config = params.ctx.config ?? getRuntimeConfig();
  const ctx = { ...params.ctx, foregroundPromptContext: params.ctx.foregroundPromptContext };
  try {
    const anchor = readActiveTranscriptEntryAnchor(source);
    if (!anchor) {
      return;
    }
    scheduleSkillExperienceReview({
      event: params.event,
      ctx,
      usedSkills,
      config,
      source: anchor,
    });
  } catch (error) {
    // Side effects are observational; failures must not change the completed run result.
    log.warn(`skill experience review scheduling failed: ${String(error)}`);
  }
}

/** Starts agent-end side effects without waiting for completion. */
export function runAgentEndSideEffects(params: AgentEndSideEffectsParams): void {
  runCoreAgentEndSideEffects(params);
  runAgentHarnessAgentEndHook(params);
}

/** Runs agent-end side effects and waits for plugin/core completion. */
export async function awaitAgentEndSideEffects(params: AgentEndSideEffectsParams): Promise<void> {
  runCoreAgentEndSideEffects(params);
  await awaitAgentHarnessAgentEndHook(params);
}
