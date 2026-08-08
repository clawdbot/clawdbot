import { randomUUID } from "node:crypto";
import { resolveDefaultModelForAgent } from "../../agents/model-selection-config.js";
import { SessionManager } from "../../agents/sessions/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { CommandLane } from "../../process/lanes.js";
import {
  buildSkillHistoryScanPrompt,
  type SkillHistoryScanPromptSession,
} from "./history-scan-prompt.js";
import {
  HISTORY_SCAN_MAX_PROPOSAL_MUTATIONS,
  resolveSkillHistoryScanReviewOutcome,
  resolveSkillHistoryScanRunFailure,
} from "./history-scan-review-outcome.js";
import type { SkillWorkshopProposalReviewProgress } from "./types.js";

export const HISTORY_SCAN_SESSION_SEGMENT = "skill-workshop-history-scan";
const HISTORY_SCAN_TIMEOUT_MS = 10 * 60_000;

export async function runSkillHistoryScanReview(params: {
  agentId: string;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  modelRef?: { model: string; provider: string };
  onComplete?: (ideasFound: number) => Promise<void>;
  onProgress?: (progress: SkillWorkshopProposalReviewProgress) => Promise<void>;
  progress?: SkillWorkshopProposalReviewProgress;
  runId?: string;
  sessions: readonly SkillHistoryScanPromptSession[];
  workspaceDir: string;
}): Promise<number> {
  if (params.sessions.length === 0) {
    return 0;
  }
  const modelRef =
    params.modelRef ?? resolveDefaultModelForAgent({ cfg: params.config, agentId: params.agentId });
  const proposalMutationBudget = {
    remaining: params.progress?.remaining ?? HISTORY_SCAN_MAX_PROPOSAL_MUTATIONS,
    completed: params.progress?.proposalIds.length ?? 0,
    successfulMutations: params.progress?.successfulMutations ?? 0,
    failedMutations: 0,
    mutatedProposalIds: new Set(params.progress?.proposalIds),
  };
  const proposalReviewCompletion = params.onComplete
    ? {
        completed: false,
        complete: async () => {
          const ideasFound = resolveSkillHistoryScanReviewOutcome({
            ideasFound: proposalMutationBudget.completed,
            proposalMutationBudgetRemaining: proposalMutationBudget.remaining,
            successfulMutations: proposalMutationBudget.successfulMutations,
            failedMutations: proposalMutationBudget.failedMutations,
          });
          await params.onComplete?.(ideasFound);
        },
        recordProgress: params.onProgress,
      }
    : undefined;
  const runId = params.runId ?? `${HISTORY_SCAN_SESSION_SEGMENT}:${randomUUID()}`;
  let runError: unknown;
  try {
    const sessionId = randomUUID();
    const sessionKey = `agent:${params.agentId}:${HISTORY_SCAN_SESSION_SEGMENT}:incognito-${sessionId}`;
    const { runEmbeddedAgent } = await import("../../agents/embedded-agent.js");
    const result = await runEmbeddedAgent({
      sessionId,
      sessionKey,
      sandboxSessionKey: sessionKey,
      sessionManager: SessionManager.inMemory(params.workspaceDir),
      agentId: params.agentId,
      trigger: "manual",
      lane: CommandLane.SkillWorkshopReview,
      agentHarnessId: "openclaw",
      agentHarnessRuntimeOverride: "openclaw",
      workspaceDir: params.workspaceDir,
      config: params.config,
      prompt: buildSkillHistoryScanPrompt({
        sessions: params.sessions,
        requireCompletion: proposalReviewCompletion !== undefined,
      }),
      provider: modelRef.provider,
      model: modelRef.model,
      // A smaller configured fallback must not receive a prompt sized for the primary model.
      modelFallbacksOverride: [],
      timeoutMs: HISTORY_SCAN_TIMEOUT_MS,
      runId,
      toolsAllow: ["skill_workshop"],
      disableMessageTool: true,
      disableTrajectory: true,
      skillWorkshopProposalOnly: true,
      skillWorkshopProposalEnv: params.env,
      skillWorkshopProposalMutationBudget: proposalMutationBudget,
      skillWorkshopProposalReviewCompletion: proposalReviewCompletion,
      skillWorkshopOrigin: { agentId: params.agentId, runId },
      cleanupBundleMcpOnRunEnd: true,
      bootstrapContextMode: "lightweight",
      skillsSnapshot: { prompt: "", skills: [] },
      verboseLevel: "off",
      reasoningLevel: "off",
      suppressToolErrorWarnings: true,
    });
    runError = resolveSkillHistoryScanRunFailure(result);
  } catch (error) {
    runError = error;
  }
  if (proposalReviewCompletion?.completed) {
    return proposalMutationBudget.completed;
  }
  return resolveSkillHistoryScanReviewOutcome({
    ideasFound: proposalMutationBudget.completed,
    proposalMutationBudgetRemaining: proposalMutationBudget.remaining,
    successfulMutations: proposalMutationBudget.successfulMutations,
    failedMutations: proposalMutationBudget.failedMutations,
    ...(runError === undefined ? {} : { runError }),
  });
}
