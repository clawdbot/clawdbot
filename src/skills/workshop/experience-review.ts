import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../../agents/cron-creator-authority-context.js";
import { rootedAgentRunParams } from "../../agents/rooted-run-params.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveInternalSessionEffectsIdentity } from "../../config/sessions/internal-session-key.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { validateSessionTranscriptContextAnchor } from "../../config/sessions/session-accessor.sqlite-model-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  getGatewayRestartDrainSignal,
  runWithGatewayIndependentRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { bumpSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { recordSkillExperienceReviewOutcome } from "./collection-review-state.js";
import { resolveSkillWorkshopConfig } from "./config.js";
import { buildSkillExperienceReviewPrompt } from "./experience-review-prompt.js";
import type { ExperienceReviewCandidate } from "./experience-review-scheduler.js";
import { SKILL_WORKSHOP_MAINTENANCE_TOOLS } from "./maintenance-prompt.js";
import { assertSkillReviewRunSucceeded } from "./review-outcome.js";
import { runSkillWorkshopReview } from "./review-run.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";
import type { SkillWorkshopProposalMutationBudget } from "./types.js";

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
    resolveSkillWorkshopConfig(config).autonomous.mode === "propose" &&
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
): Promise<void> {
  // The foreground root has closed by the idle timer's callback. Admit this
  // detached review independently; a real Gateway drain still refuses it.
  await runWithGatewayIndependentRootWorkAdmission(
    () => runSkillExperienceReviewInner(candidate),
    "skills:experience-review",
  );
}

async function runSkillExperienceReviewInner(candidate: ExperienceReviewCandidate): Promise<void> {
  // Reset replaces the global controller; this review keeps its original lifetime
  // across model execution and outcome publication.
  const abortSignal = getGatewayRestartDrainSignal();
  const { foregroundPromptContext, workspaceDir } = candidate.ctx;
  const { sessionKey } = candidate.source;
  const config = candidate.config;
  const mode = resolveSkillWorkshopConfig(config).autonomous.mode;
  if (mode === "off") {
    return;
  }
  const executionRoot =
    mode === "auto" ? resolveWorkshopSkillsDir(config, foregroundPromptContext.agentId) : undefined;
  const runId = `skill-workshop-review:${randomUUID()}`;
  const reviewSession = resolveInternalSessionEffectsIdentity({
    agentId: foregroundPromptContext.agentId,
    runId,
  });
  const origin = foregroundPromptContext.cronCreatorCallerOrigin;
  const capability = origin ? createCronCreatorAuthorityCapability(runId, origin) : undefined;
  const proposalMutationBudget: SkillWorkshopProposalMutationBudget | undefined =
    mode === "propose" ? { remaining: 1, readSkillHashes: new Map() } : undefined;
  const attemptedAtMs = Date.now();
  let outcome: "completed" | "proposed" | "nothing";
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
    if (executionRoot) {
      await fs.mkdir(executionRoot, { recursive: true });
    }
    const sessionManager = await SessionManager.openModelContextAsync(candidate.source, {
      cwd: executionRoot ?? workspaceDir,
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
    const existingSkills =
      mode === "propose"
        ? listWritableWorkshopSkillSummaries({ config, agentId: foregroundPromptContext.agentId })
        : undefined;
    validateSessionTranscriptContextAnchor(candidate.source, candidate.source);
    // Source revocation fences retained tools and completion, even when the
    // model handles a denied tool call and returns a normal final response.
    const assertSourceCurrent = () => {
      abortSignal.throwIfAborted();
      if (
        mode === "auto" &&
        resolveSkillWorkshopConfig(getRuntimeConfig()).autonomous.mode !== "auto"
      ) {
        throw new Error("Automatic Skill Workshop maintenance was disabled during review.");
      }
      const current = loadSessionEntryReadOnly({
        ...candidate.source,
        hydrateSkillPromptRefs: false,
        readConsistency: "latest",
      });
      if (
        current?.sessionId !== candidate.source.sessionId ||
        current?.permissionMode !== sourceEntry.permissionMode
      ) {
        throw new Error(
          "Skill experience review source session was deleted, replaced, or changed permissions.",
        );
      }
      validateSessionTranscriptContextAnchor(candidate.source, candidate.source);
    };
    const preparedRunAdmission = prepareAgentRunAdmission({
      cfg: config,
      operationalRunInstance: createOperationalRunInstanceRef(runId),
      facts: {
        runId,
        agentId: foregroundPromptContext.agentId,
        ingress: { kind: "system", boundary: "skill-workshop.experience", state: "present" },
      },
      assertSourceCurrent,
    });
    const run = () =>
      runSkillWorkshopReview({
        reviewKind: "experience",
        ...foregroundPromptContext,
        preparedRunAdmission,
        sessionId: reviewSession.sessionId,
        sessionKey: reviewSession.sessionKey,
        // Delivery authority closes with the foreground turn and cannot be reused by this fork.
        messageActionTurnCapability: undefined,
        sessionManager,
        sessionPersistence: "detached",
        workspaceDir,
        ...(executionRoot ? rootedAgentRunParams(workspaceDir, executionRoot) : {}),
        permissionMode: sourceEntry.permissionMode ?? foregroundPromptContext.permissionMode,
        ...(executionRoot ? { skillsSnapshot: { prompt: "", skills: [] } } : {}),
        config,
        abortSignal,
        prompt: buildSkillExperienceReviewPrompt({ ...candidate, existingSkills }, mode),
        provider: candidate.ctx.modelProviderId,
        model: candidate.ctx.modelId,
        ...(candidate.ctx.authProfileId
          ? { authProfileId: candidate.ctx.authProfileId, authProfileIdSource: "user" as const }
          : {}),
        timeoutMs: resolveAgentTimeoutMs({ cfg: config }),
        runId,
        silentExpected: true,
        allowEmptyAssistantReplyAsSilent: true,
        terminalReplyExpectation: "optional",
        toolExecutionAllow:
          mode === "auto" ? [...SKILL_WORKSHOP_MAINTENANCE_TOOLS] : ["skill_workshop"],
        skillWorkshopProposalOnly: mode === "propose",
        skillWorkshopUpdateProposals: mode === "propose",
        skillWorkshopAutonomousCapture: mode === "propose",
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
    preparedRunAdmission.assertSourceCurrent();

    // Direct edits have normal file-tool semantics; drafts remain pending even
    // if the operator enables automatic maintenance while this review runs.
    assertSkillReviewRunSucceeded(embeddedResult);
    const proposalIds = [...(proposalMutationBudget?.mutatedProposalIds ?? [])];
    proposalId = proposalIds[0];
    outcome = mode === "auto" ? "completed" : proposalIds.length === 0 ? "nothing" : "proposed";
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
    if (executionRoot) {
      bumpSkillsSnapshotVersion({ reason: "workshop" });
    }
    clearAgentRunContext(runId);
  }
  recordSkillExperienceReviewOutcome(foregroundPromptContext.agentId, workspaceDir, {
    attemptedAtMs,
    outcome,
    ...(proposalId ? { proposalId } : {}),
    ...(usage ? { usage } : {}),
  });
}
