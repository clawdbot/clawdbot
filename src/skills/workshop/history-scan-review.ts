import { randomUUID } from "node:crypto";
import { resolveDefaultModelForAgent } from "../../agents/model-selection-config.js";
import { SessionManager } from "../../agents/sessions/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildSkillHistoryScanPrompt,
  type SkillHistoryScanPromptSession,
} from "./history-scan-prompt.js";
import {
  HISTORY_SCAN_MAX_PROPOSAL_MUTATIONS,
  resolveSkillHistoryScanReviewOutcome,
  assertSkillReviewRunSucceeded,
} from "./review-outcome.js";
import { runSkillWorkshopReview } from "./review-run.js";
import type {
  SkillWorkshopProposalReviewCompletion,
  SkillWorkshopProposalReviewProgress,
} from "./types.js";

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
    successfulMutations: params.progress?.successfulMutations ?? 0,
    failedMutations: 0,
    mutatedProposalIds: new Set(params.progress?.proposalIds),
  };
  const proposalReviewCompletion: SkillWorkshopProposalReviewCompletion | undefined =
    params.onComplete
      ? {
          phase: "open",
          complete: async () => {
            const ideasFound = resolveSkillHistoryScanReviewOutcome({
              ideasFound: proposalMutationBudget.mutatedProposalIds.size,
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
    const result = await runSkillWorkshopReview({
      reviewKind: "history-scan",
      sessionId,
      sessionKey,
      sandboxSessionKey: sessionKey,
      sessionManager: SessionManager.inMemory(params.workspaceDir),
      agentId: params.agentId,
      trigger: "manual",
      workspaceDir: params.workspaceDir,
      config: params.config,
      prompt: buildSkillHistoryScanPrompt({
        sessions: params.sessions,
        requireCompletion: proposalReviewCompletion !== undefined,
      }),
      provider: modelRef.provider,
      model: modelRef.model,
      timeoutMs: HISTORY_SCAN_TIMEOUT_MS,
      runId,
      toolsAllow: ["skill_workshop"],
      skillWorkshopProposalEnv: params.env,
      skillWorkshopProposalMutationBudget: proposalMutationBudget,
      skillWorkshopProposalReviewCompletion: proposalReviewCompletion,
      skillWorkshopOrigin: { agentId: params.agentId, runId },
      bootstrapContextMode: "lightweight",
      skillsSnapshot: { prompt: "", skills: [] },
      reasoningLevel: "off",
    });
    assertSkillReviewRunSucceeded(result);
  } catch (error) {
    runError = error;
  }
  if (proposalReviewCompletion?.phase === "completed") {
    return proposalMutationBudget.mutatedProposalIds.size;
  }
  return resolveSkillHistoryScanReviewOutcome({
    ideasFound: proposalMutationBudget.mutatedProposalIds.size,
    proposalMutationBudgetRemaining: proposalMutationBudget.remaining,
    successfulMutations: proposalMutationBudget.successfulMutations,
    failedMutations: proposalMutationBudget.failedMutations,
    ...(runError === undefined ? {} : { runError }),
  });
}
