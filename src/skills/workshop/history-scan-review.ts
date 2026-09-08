import { randomUUID } from "node:crypto";
import { SessionManager } from "../../agents/sessions/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildSkillHistoryScanPrompt,
  type SkillHistoryScanPromptSession,
} from "./history-scan-prompt.js";
import {
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
  modelRef: { model: string; provider: string };
  onComplete: (ideasFound: number) => Promise<void>;
  onProgress: (progress: SkillWorkshopProposalReviewProgress) => Promise<void>;
  progress: SkillWorkshopProposalReviewProgress;
  runId: string;
  sessions: readonly SkillHistoryScanPromptSession[];
  workspaceDir: string;
}): Promise<void> {
  const proposalMutationBudget = {
    remaining: params.progress.remaining,
    successfulMutations: params.progress.successfulMutations,
    failedMutations: 0,
    mutatedProposalIds: new Set(params.progress.proposalIds),
  };
  const proposalReviewCompletion: SkillWorkshopProposalReviewCompletion = {
    phase: "open",
    complete: async () => {
      const ideasFound = resolveSkillHistoryScanReviewOutcome({
        ideasFound: proposalMutationBudget.mutatedProposalIds.size,
        proposalMutationBudgetRemaining: proposalMutationBudget.remaining,
        successfulMutations: proposalMutationBudget.successfulMutations,
        failedMutations: proposalMutationBudget.failedMutations,
      });
      await params.onComplete(ideasFound);
    },
    recordProgress: params.onProgress,
  };
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
    prompt: buildSkillHistoryScanPrompt({ sessions: params.sessions }),
    provider: params.modelRef.provider,
    model: params.modelRef.model,
    timeoutMs: HISTORY_SCAN_TIMEOUT_MS,
    runId: params.runId,
    toolsAllow: ["skill_workshop"],
    skillWorkshopProposalEnv: params.env,
    skillWorkshopProposalMutationBudget: proposalMutationBudget,
    skillWorkshopProposalReviewCompletion: proposalReviewCompletion,
    skillWorkshopOrigin: { agentId: params.agentId, runId: params.runId },
    bootstrapContextMode: "lightweight",
    skillsSnapshot: { prompt: "", skills: [] },
    reasoningLevel: "off",
  });
  // The batch owner reconciles its durable completion even after a late run failure.
  assertSkillReviewRunSucceeded(result);
}
