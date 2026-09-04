/**
 * Agent-end side effect runner.
 *
 * Harnesses use this to trigger skill experience review and plugin agent_end hooks
 * either fire-and-forget or awaited during tests/shutdown.
 */
import { getRuntimeConfig } from "../../config/config.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { consumeRunSkillUsage } from "../../skills/runtime/run-usage.js";
import { recordSkillExperienceReviewOutcome } from "../../skills/workshop/collection-review-state.js";
import { scheduleSkillExperienceReview } from "../../skills/workshop/experience-review-default.js";
import type { EmbeddedForegroundPromptContext } from "../embedded-agent-runner/run/params.js";
import { SessionManager } from "../sessions/session-manager.js";
import {
  awaitAgentHarnessAgentEndHook,
  runAgentHarnessAgentEndHook,
} from "./lifecycle-hook-helpers.js";

const log = createSubsystemLogger("agents/harness");

type BaseAgentEndSideEffectsParams = Parameters<typeof runAgentHarnessAgentEndHook>[0];
type AgentEndSideEffectsParams = Omit<BaseAgentEndSideEffectsParams, "ctx"> & {
  /** Private source identity for capture before the producer releases its completed turn. */
  skillExperienceReviewSource?: SessionTranscriptRuntimeTarget;
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
    const target = {
      agentId: source.agentId,
      sessionId: source.sessionId,
      sessionKey: source.sessionKey,
      storePath: source.storePath,
    };
    scheduleSkillExperienceReview({
      event: params.event,
      ctx,
      usedSkills,
      config,
      source: {
        target,
        captureContext: (workspaceDir) => {
          try {
            return SessionManager.openModelContext(target, { cwd: workspaceDir });
          } catch (error) {
            recordSkillExperienceReviewOutcome(target.agentId, workspaceDir, {
              attemptedAtMs: Date.now(),
              outcome: "failed",
              error: String(error).slice(0, 300),
            });
            throw error;
          }
        },
      },
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
