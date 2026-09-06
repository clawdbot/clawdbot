import { randomUUID } from "node:crypto";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../../agents/cron-creator-authority-context.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { resolveInternalSessionEffectsIdentity } from "../../config/sessions/internal-session-key.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { validateSessionTranscriptContextAnchor } from "../../config/sessions/session-accessor.sqlite-model-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  getGatewayRestartDrainSignal,
  runWithGatewayIndependentRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { recordSkillExperienceReviewOutcome } from "./collection-review-state.js";
import { resolveSkillWorkshopConfig } from "./config.js";
import { buildSkillExperienceReviewPrompt } from "./experience-review-prompt.js";
import type { ExperienceReviewCandidate } from "./experience-review-scheduler.js";
import { assertSkillReviewRunSucceeded } from "./review-outcome.js";
import { runSkillWorkshopReview } from "./review-run.js";
import { applySkillProposal, inspectSkillProposal } from "./service.js";
import type { SkillWorkshopProposalMutationBudget } from "./types.js";

const EXPERIENCE_REVIEW_TIMEOUT_MS = 120_000;

type ExperienceReviewRunDeps = {
  getCurrentConfig?: () => OpenClawConfig | Promise<OpenClawConfig>;
};

export async function prepareSkillExperienceReviewCandidate(
  candidate: ExperienceReviewCandidate,
  config: OpenClawConfig,
): Promise<ExperienceReviewCandidate | undefined> {
  if (resolveSkillWorkshopConfig(config).autonomous.mode === "off") {
    return undefined;
  }
  const { resolveConversationCapabilityProfile } =
    await import("../../agents/conversation-capability-profile.js");
  const { resolveSandboxRuntimeStatus } = await import("../../agents/sandbox.js");
  const { isToolAllowedByPolicies } = await import("../../agents/tool-policy-match.js");
  const { mergeAlsoAllowPolicy } = await import("../../agents/tool-policy.js");
  const foreground = candidate.ctx.foregroundPromptContext;
  const sessionKey = candidate.source.sessionKey;
  if (
    resolveSandboxRuntimeStatus({ cfg: config, sessionKey, agentId: foreground.agentId }).sandboxed
  ) {
    return undefined;
  }
  const capabilityProfile = resolveConversationCapabilityProfile({
    config,
    sessionKey,
    sandboxSessionKey: sessionKey,
    agentId: foreground.agentId,
    agentAccountId: foreground.agentAccountId,
    messageProvider: foreground.messageProvider,
    messageChannel: foreground.messageChannel,
    chatType: foreground.chatType,
    groupId: foreground.groupId,
    groupChannel: foreground.groupChannel,
    groupSpace: foreground.groupSpace,
    memberRoleIds: foreground.memberRoleIds,
    spawnedBy: foreground.spawnedBy,
    senderId: foreground.senderId,
    senderName: foreground.senderName,
    senderUsername: foreground.senderUsername,
    senderE164: foreground.senderE164,
    senderIsOwner: foreground.senderIsOwner,
    modelProvider: candidate.ctx.modelProviderId,
    modelId: candidate.ctx.modelId,
    workspaceDir: candidate.ctx.workspaceDir,
  });
  const profilePolicy = mergeAlsoAllowPolicy(
    capabilityProfile.policy.profilePolicy,
    capabilityProfile.policy.profileAlsoAllow,
  );
  const providerProfilePolicy = mergeAlsoAllowPolicy(
    capabilityProfile.policy.providerProfilePolicy,
    capabilityProfile.policy.providerProfileAlsoAllow,
  );
  if (
    !isToolAllowedByPolicies("skill_workshop", [
      profilePolicy,
      providerProfilePolicy,
      capabilityProfile.policy.globalPolicy,
      capabilityProfile.policy.globalProviderPolicy,
      capabilityProfile.policy.agentPolicy,
      capabilityProfile.policy.agentProviderPolicy,
      capabilityProfile.policy.groupPolicy,
      capabilityProfile.policy.senderPolicy,
      capabilityProfile.policy.subagentPolicy,
      capabilityProfile.policy.inheritedToolPolicy,
    ])
  ) {
    return undefined;
  }
  return { ...candidate, config };
}

export async function runSkillExperienceReview(
  candidate: ExperienceReviewCandidate,
  deps: ExperienceReviewRunDeps = {},
): Promise<void> {
  // The foreground root has closed by the idle timer's callback. Admit this
  // detached review independently; a real Gateway drain still refuses it.
  await runWithGatewayIndependentRootWorkAdmission(
    () => runSkillExperienceReviewInner(candidate, deps),
    "skills:experience-review",
  );
}

async function runSkillExperienceReviewInner(
  candidate: ExperienceReviewCandidate,
  deps: ExperienceReviewRunDeps,
): Promise<void> {
  // Reset replaces the global controller; this review keeps its original lifetime
  // across model execution and entry to autonomous apply.
  const abortSignal = getGatewayRestartDrainSignal();
  const { foregroundPromptContext, workspaceDir } = candidate.ctx;
  const { sessionKey } = candidate.source;
  const config = candidate.config;
  const runId = `skill-workshop-review:${randomUUID()}`;
  const reviewSession = resolveInternalSessionEffectsIdentity({
    agentId: foregroundPromptContext.agentId,
    runId,
  });
  const origin = foregroundPromptContext.cronCreatorCallerOrigin;
  const capability = origin ? createCronCreatorAuthorityCapability(runId, origin) : undefined;
  const proposalMutationBudget: SkillWorkshopProposalMutationBudget = {
    remaining: 1,
    readSkillHashes: new Map(),
  };
  const attemptedAtMs = Date.now();
  let outcome: "applied" | "proposed" | "nothing";
  let proposalId: string | undefined;
  let usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | undefined;
  // Runtime identity is private; the captured promptCacheKey retains foreground cache affinity.
  registerAgentRunContext(runId, {
    agentId: foregroundPromptContext.agentId,
    sessionId: reviewSession.sessionId,
    sessionKey: reviewSession.sessionKey,
    isControlUiVisible: false,
    projectSessionActive: false,
    projectSessionLifecycle: false,
    projectSessionMessages: false,
  });
  try {
    abortSignal.throwIfAborted();
    const sessionManager = await SessionManager.openModelContextAsync(candidate.source, {
      cwd: workspaceDir,
      through: candidate.source,
      signal: abortSignal,
    });
    abortSignal.throwIfAborted();
    const { listWritableWorkshopSkillSummaries } = await import("./workspace-skill-read.js");
    abortSignal.throwIfAborted();
    // Deleting or replacing the source session must not revive its captured evidence.
    // Check after asynchronous preparation; a replacement can retain the old transcript.
    const sourceEntry = loadSessionEntryReadOnly({
      ...candidate.source,
      hydrateSkillPromptRefs: false,
      readConsistency: "latest",
    });
    if (sourceEntry?.sessionId !== candidate.source.sessionId) {
      throw new Error("Skill experience review source session was deleted or replaced.");
    }
    const existingSkills = listWritableWorkshopSkillSummaries({
      config,
      agentId: foregroundPromptContext.agentId,
    });
    validateSessionTranscriptContextAnchor(candidate.source, candidate.source);
    const run = () =>
      runSkillWorkshopReview({
        reviewKind: "experience",
        ...foregroundPromptContext,
        sessionId: reviewSession.sessionId,
        sessionKey: reviewSession.sessionKey,
        // Delivery authority closes with the foreground turn and cannot be reused by this fork.
        messageActionTurnCapability: undefined,
        sessionManager,
        sessionPersistence: "detached",
        workspaceDir,
        config,
        abortSignal,
        prompt: buildSkillExperienceReviewPrompt({ ...candidate, existingSkills }),
        provider: candidate.ctx.modelProviderId,
        model: candidate.ctx.modelId,
        ...(candidate.ctx.authProfileId
          ? { authProfileId: candidate.ctx.authProfileId, authProfileIdSource: "user" as const }
          : {}),
        timeoutMs: EXPERIENCE_REVIEW_TIMEOUT_MS,
        runId,
        silentExpected: true,
        allowEmptyAssistantReplyAsSilent: true,
        terminalReplyExpectation: "optional",
        toolExecutionAllow: ["skill_workshop"],
        skillWorkshopUpdateProposals: true,
        skillWorkshopAutonomousCapture: true,
        skillWorkshopProposalMutationBudget: proposalMutationBudget,
        skillWorkshopOrigin: {
          agentId: foregroundPromptContext.agentId,
          sessionKey,
          ...(candidate.ctx.runId ? { runId: candidate.ctx.runId } : {}),
        },
        ...(capability ? { cronCreatorAuthorityCapability: capability } : {}),
      });
    const embeddedResult = capability
      ? await runWithCronCreatorAuthorityCapability(capability, run)
      : await run();
    abortSignal.throwIfAborted();

    // A failed review can leave a pending proposal; never auto-apply it.
    assertSkillReviewRunSucceeded(embeddedResult);
    const proposalIds = [...(proposalMutationBudget.mutatedProposalIds ?? [])];
    proposalId = proposalIds[0];
    outcome = proposalIds.length === 0 ? "nothing" : "proposed";
    const currentConfig = deps.getCurrentConfig
      ? await deps.getCurrentConfig()
      : (await import("../../config/config.js")).getRuntimeConfig();
    abortSignal.throwIfAborted();
    if (resolveSkillWorkshopConfig(currentConfig).autonomous.mode === "auto") {
      abortSignal.throwIfAborted();
      for (const mutatedProposalId of proposalIds) {
        // An entered apply owns its commit/rollback; fence any subsequent proposal.
        abortSignal.throwIfAborted();
        const proposal = await inspectSkillProposal(mutatedProposalId, {
          agentId: foregroundPromptContext.agentId,
          config: currentConfig,
        });
        abortSignal.throwIfAborted();
        if (
          !proposal ||
          proposal.record.status !== "pending" ||
          proposal.record.autonomousCapture !== true
        ) {
          continue;
        }
        await applySkillProposal({
          workspaceDir,
          agentId: foregroundPromptContext.agentId,
          config: currentConfig,
          proposalId: proposal.record.id,
          expectedRevisionHash: proposal.revisionHash,
          reason: "Autonomous self-learning capture",
        });
        outcome = "applied";
      }
    }
    const agentUsage = embeddedResult.meta?.agentMeta?.usage;
    usage = agentUsage
      ? {
          inputTokens:
            (agentUsage.input ?? 0) + (agentUsage.cacheRead ?? 0) + (agentUsage.cacheWrite ?? 0),
          cachedInputTokens: agentUsage.cacheRead ?? 0,
          outputTokens: agentUsage.output ?? 0,
        }
      : undefined;
  } catch (error) {
    recordSkillExperienceReviewOutcome(foregroundPromptContext.agentId, workspaceDir, {
      attemptedAtMs,
      outcome: "failed",
      error: String(error).slice(0, 300),
    });
    throw error;
  } finally {
    clearAgentRunContext(runId);
  }
  recordSkillExperienceReviewOutcome(foregroundPromptContext.agentId, workspaceDir, {
    attemptedAtMs,
    outcome,
    ...(proposalId ? { proposalId } : {}),
    ...(usage ? { usage } : {}),
  });
}
