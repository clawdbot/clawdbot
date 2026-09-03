import { randomUUID } from "node:crypto";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../../agents/cron-creator-authority-context.js";
import type { EmbeddedForegroundPromptContext } from "../../agents/embedded-agent-runner/run/params.js";
import { runOutsidePreparedModelRuntimePluginGenerationScope } from "../../agents/prepared-model-runtime-generation-scope.js";
import { resolveAgentRunSessionTarget } from "../../agents/run-session-target.js";
import { SessionManager } from "../../agents/sessions/index.js";
import { getCanonicalSkillWorkspace } from "../../agents/skill-workshop-workspace-context.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveInternalSessionEffectsIdentity } from "../../config/sessions/internal-session-key.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../../process/gateway-work-admission.js";
import type { RunSkillUsage } from "../runtime/run-usage.js";
import { applyAutonomousSkillProposal } from "./autonomous-apply.js";
import { recordSkillExperienceReviewOutcome } from "./collection-review-state.js";
import { resolveSkillWorkshopConfig } from "./config.js";
import {
  buildSkillExperienceReviewPrompt,
  countSkillModelIterations,
  selectCurrentSkillTurnMessages,
} from "./experience-review-prompt.js";
import { assertSkillReviewRunSucceeded } from "./review-outcome.js";
import { runSkillWorkshopReview } from "./review-run.js";
import type { SkillWorkshopProposalMutationBudget } from "./types.js";

const EXPERIENCE_REVIEW_MIN_MODEL_ITERATIONS = 10;
const EXPERIENCE_REVIEW_IDLE_MS = 30_000;
const EXPERIENCE_REVIEW_RETRY_IDLE_MS = 30_000;
const EXPERIENCE_REVIEW_TIMEOUT_MS = 120_000;
const EXPERIENCE_REVIEW_MAX_PENDING = 32;
const EXPERIENCE_REVIEW_BLOCKED_TRIGGERS = new Set(["cron", "heartbeat", "memory", "overflow"]);
const EXPERIENCE_REVIEW_BLOCKED_SESSION_SEGMENTS = new Set([
  "cron",
  "hook",
  "subagent",
  "skill-workshop-review",
]);

const log = createSubsystemLogger("skills/workshop");

type ExperienceReviewAgentEndEvent = {
  messages: unknown[];
  success: boolean;
  error?: string;
};

type ExperienceReviewAgentContext = {
  agentId?: string;
  runId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  modelProviderId?: string;
  modelId?: string;
  modelContextWindowTokens?: number;
  authProfileId?: string;
  modelIterations?: number;
  skillWorkshopAvailable?: boolean;
  compacted?: boolean;
  foregroundPromptContext: EmbeddedForegroundPromptContext;
};

export type SkillExperienceReviewParams = {
  event: ExperienceReviewAgentEndEvent;
  ctx: ExperienceReviewAgentContext;
  usedSkills?: readonly RunSkillUsage[];
  config?: OpenClawConfig;
};

export type ExperienceReviewCandidate = {
  ctx: ExperienceReviewAgentContext;
  config?: OpenClawConfig;
  usedSkills?: readonly RunSkillUsage[];
  turnAborted?: boolean;
};

type ExperienceReviewRunDeps = {
  getCurrentConfig?: () => OpenClawConfig | Promise<OpenClawConfig>;
};

type ExperienceReviewTimer = ReturnType<typeof setTimeout>;

type ExperienceReviewSchedulerDeps = {
  isSystemActive: () => boolean | Promise<boolean>;
  runReview: (candidate: ExperienceReviewCandidate) => Promise<void>;
  prepareReview?: (
    candidate: ExperienceReviewCandidate,
  ) => ExperienceReviewCandidate | undefined | Promise<ExperienceReviewCandidate | undefined>;
  setTimer?: (callback: () => void, delayMs: number) => ExperienceReviewTimer;
  clearTimer?: (timer: ExperienceReviewTimer) => void;
};

type PendingExperienceReview = {
  candidate: ExperienceReviewCandidate;
  generation: number;
  timer?: ExperienceReviewTimer;
};

function isEligibleContext(ctx: ExperienceReviewAgentContext): boolean {
  // Only harnesses that report both the resolved model and actual host-side
  // Workshop availability may schedule. Other runtimes fail closed here.
  if (
    ctx.compacted === true ||
    ctx.skillWorkshopAvailable !== true ||
    !ctx.modelProviderId?.trim() ||
    !ctx.modelId?.trim()
  ) {
    return false;
  }
  const trigger = ctx.foregroundPromptContext.trigger?.trim().toLowerCase();
  if (trigger && EXPERIENCE_REVIEW_BLOCKED_TRIGGERS.has(trigger)) {
    return false;
  }
  const sessionKey = ctx.sessionKey?.trim().toLowerCase();
  if (!sessionKey || sessionKey.includes("active-memory")) {
    return false;
  }
  return !sessionKey
    .split(":")
    .some((segment) => EXPERIENCE_REVIEW_BLOCKED_SESSION_SEGMENTS.has(segment));
}

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
  const sessionKey = candidate.ctx.sessionKey;
  if (
    !sessionKey ||
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

export function createSkillExperienceReviewScheduler(deps: ExperienceReviewSchedulerDeps) {
  const pendingBySession = new Map<string, PendingExperienceReview>();
  let reviewInFlight = false;
  const setTimer = deps.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = deps.clearTimer ?? clearTimeout;

  const arm = (key: string, pending: PendingExperienceReview, delayMs: number) => {
    if (pending.timer) {
      clearTimer(pending.timer);
    }
    const generation = ++pending.generation;
    const timerCallback = () => {
      if (pendingBySession.get(key) !== pending || pending.generation !== generation) {
        return;
      }
      pending.timer = undefined;
      void Promise.resolve(deps.isSystemActive())
        .then(async (active) => {
          if (pendingBySession.get(key) !== pending || pending.generation !== generation) {
            return;
          }
          if (active || reviewInFlight) {
            arm(key, pending, EXPERIENCE_REVIEW_RETRY_IDLE_MS);
            return;
          }
          reviewInFlight = true;
          try {
            pendingBySession.delete(key);
            const candidate = deps.prepareReview
              ? await deps.prepareReview(pending.candidate)
              : pending.candidate;
            if (!candidate) {
              return;
            }
            await deps.runReview(candidate);
          } finally {
            reviewInFlight = false;
          }
        })
        .catch((error: unknown) => {
          log.warn(`skill experience review failed: ${String(error)}`);
          if (pendingBySession.get(key) === pending && pending.generation === generation) {
            pendingBySession.delete(key);
          }
        });
    };
    // This timer outlives the foreground turn that armed it. Create its async
    // resource outside the parent scope so review work admits on the current generation.
    const timer = runOutsidePreparedModelRuntimePluginGenerationScope(() =>
      setTimer(timerCallback, delayMs),
    );
    pending.timer = timer;
    timer.unref?.();
  };

  return {
    schedule(params: SkillExperienceReviewParams): void {
      const sessionKey = params.ctx.sessionKey?.trim();
      if (!sessionKey) {
        return;
      }
      // Unqualified keys such as global still belong to one foreground agent.
      const key = JSON.stringify([params.ctx.foregroundPromptContext.agentId, sessionKey]);
      const existing = pendingBySession.get(key);
      // Errored completions (provider/prompt failures) are transient environment
      // noise, not learnable evidence, and a same-model review would likely hit
      // the same failure. User aborts carry no error and stay eligible: deep
      // interrupted turns are exactly where corrective evidence lives.
      const errored = typeof params.event.error === "string" && params.event.error.trim() !== "";
      if (
        existing &&
        errored &&
        params.ctx.runId?.trim() &&
        params.ctx.runId === existing.candidate.ctx.runId
      ) {
        if (existing.timer) {
          clearTimer(existing.timer);
        }
        pendingBySession.delete(key);
        return;
      }
      // Quiet time follows all later foreground work in the session. Candidate
      // eligibility only decides whether that completion can replace the evidence.
      if (existing) {
        arm(key, existing, EXPERIENCE_REVIEW_IDLE_MS);
      }
      if (errored) {
        log.debug(`experience review skipped: reason=errored-completion session=${sessionKey}`);
        return;
      }
      if (resolveSkillWorkshopConfig(params.config).autonomous.mode === "off") {
        return;
      }
      if (!isEligibleContext(params.ctx)) {
        log.debug(`experience review skipped: reason=ineligible-context session=${sessionKey}`);
        return;
      }
      const workspaceDir = getCanonicalSkillWorkspace() ?? params.ctx.workspaceDir?.trim();
      if (!workspaceDir) {
        log.debug(`experience review skipped: reason=missing-workspace session=${sessionKey}`);
        return;
      }

      const turnMessages = selectCurrentSkillTurnMessages(params.event.messages);
      // Native harnesses can report exact provider iterations even when their
      // transcript projection has a different assistant-message cardinality.
      const reportedModelIterations = params.ctx.modelIterations;
      const modelIterations =
        reportedModelIterations === undefined
          ? countSkillModelIterations(turnMessages)
          : Number.isSafeInteger(reportedModelIterations) && reportedModelIterations >= 0
            ? reportedModelIterations
            : 0;
      if (modelIterations < EXPERIENCE_REVIEW_MIN_MODEL_ITERATIONS) {
        log.debug(
          `experience review skipped: reason=below-depth-bar iterations=${modelIterations} session=${sessionKey}`,
        );
        return;
      }
      {
        if (!existing && pendingBySession.size >= EXPERIENCE_REVIEW_MAX_PENDING) {
          const oldest = pendingBySession.entries().next().value as
            | [string, PendingExperienceReview]
            | undefined;
          if (oldest) {
            if (oldest[1].timer) {
              clearTimer(oldest[1].timer);
            }
            pendingBySession.delete(oldest[0]);
          }
        }
        const candidate: ExperienceReviewCandidate = {
          ctx: {
            agentId: params.ctx.agentId,
            runId: params.ctx.runId,
            sessionKey,
            sessionId: params.ctx.sessionId,
            workspaceDir,
            modelProviderId: params.ctx.modelProviderId,
            modelId: params.ctx.modelId,
            modelContextWindowTokens: params.ctx.modelContextWindowTokens,
            authProfileId: params.ctx.authProfileId,
            skillWorkshopAvailable: params.ctx.skillWorkshopAvailable,
            compacted: params.ctx.compacted,
            foregroundPromptContext: params.ctx.foregroundPromptContext,
          },
          ...(params.config ? { config: params.config } : {}),
          usedSkills: params.usedSkills ? [...params.usedSkills] : undefined,
          turnAborted: !params.event.success,
        };
        const pending = existing ?? { candidate, generation: 0 };
        pending.candidate = candidate;
        pendingBySession.set(key, pending);
        arm(key, pending, EXPERIENCE_REVIEW_IDLE_MS);
        log.debug(
          `experience review scheduled: session=${sessionKey} iterations=${modelIterations} aborted=${!params.event.success}`,
        );
      }
    },
    clear(): void {
      for (const pending of pendingBySession.values()) {
        if (pending.timer) {
          clearTimer(pending.timer);
        }
      }
      pendingBySession.clear();
    },
  };
}

export async function runSkillExperienceReview(
  candidate: ExperienceReviewCandidate,
  deps: ExperienceReviewRunDeps = {},
): Promise<void> {
  // The idle timer that fires this review was armed inside the foreground
  // run's root-work ALS context. By fire time that root is released, so any
  // inherited-context lane enqueue is refused as GatewayDrainingError on a
  // healthy gateway. Re-enter admission as independent root work; real
  // restart drain still refuses it.
  await runWithGatewayIndependentRootWorkAdmission(
    () => runSkillExperienceReviewInner(candidate, deps),
    "skills:experience-review",
  );
}

async function runSkillExperienceReviewInner(
  candidate: ExperienceReviewCandidate,
  deps: ExperienceReviewRunDeps,
): Promise<void> {
  const foregroundPromptContext = candidate.ctx.foregroundPromptContext;
  const workspaceDir = getCanonicalSkillWorkspace() ?? candidate.ctx.workspaceDir;
  const foregroundSessionKey = candidate.ctx.sessionKey;
  const foregroundSessionId = candidate.ctx.sessionId;
  const modelProviderId = candidate.ctx.modelProviderId?.trim();
  const modelId = candidate.ctx.modelId?.trim();
  if (
    !workspaceDir ||
    !foregroundSessionKey ||
    !foregroundSessionId ||
    !modelProviderId ||
    !modelId
  ) {
    return;
  }

  const runId = `skill-workshop-review:${randomUUID()}`;
  const reviewSession = resolveInternalSessionEffectsIdentity({
    agentId: foregroundPromptContext.agentId,
    runId,
  });
  const origin = foregroundPromptContext.cronCreatorCallerOrigin;
  const capability = origin ? createCronCreatorAuthorityCapability(runId, origin) : undefined;
  const config = candidate.config ?? getRuntimeConfig();
  const proposalMutationBudget: SkillWorkshopProposalMutationBudget = {
    remaining: 1,
    readSkillHashes: new Map(),
  };
  const attemptedAtMs = Date.now();
  let outcome: "applied" | "proposed" | "nothing";
  let proposalId: string | undefined;
  let usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | undefined;
  // The review owns a private runtime identity while the explicit promptCacheKey
  // keeps provider cache affinity with the foreground transcript it cloned.
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
    const foregroundSessionTarget = await resolveAgentRunSessionTarget({
      agentId: foregroundPromptContext.agentId,
      config,
      sessionId: foregroundSessionId,
      sessionKey: foregroundSessionKey,
      missingSessionKey: "resolve-existing",
    });
    const detachedSession = SessionManager.openModelContext(foregroundSessionTarget, {
      cwd: workspaceDir,
    });
    const { listWritableWorkspaceSkillSummaries } = await import("./workspace-skill-read.js");
    const existingSkills = listWritableWorkspaceSkillSummaries(workspaceDir, {
      config,
      agentId: foregroundPromptContext.agentId,
    });
    const run = () =>
      runSkillWorkshopReview({
        reviewKind: "experience",
        ...foregroundPromptContext,
        sessionId: reviewSession.sessionId,
        sessionKey: reviewSession.sessionKey,
        // Delivery authority closes with the foreground turn and cannot be reused by this fork.
        messageActionTurnCapability: undefined,
        sessionManager: detachedSession,
        sessionPersistence: "detached",
        workspaceDir,
        config,
        prompt: buildSkillExperienceReviewPrompt({ ...candidate, existingSkills }),
        provider: modelProviderId,
        model: modelId,
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
          sessionKey: foregroundSessionKey,
          ...(candidate.ctx.runId ? { runId: candidate.ctx.runId } : {}),
        },
        ...(capability ? { cronCreatorAuthorityCapability: capability } : {}),
      });
    const embeddedResult = capability
      ? await runWithCronCreatorAuthorityCapability(capability, run)
      : await run();

    // A failed review can leave a pending proposal; never auto-apply it.
    assertSkillReviewRunSucceeded(embeddedResult);

    const proposalIds = [...(proposalMutationBudget.mutatedProposalIds ?? [])];
    proposalId = proposalIds[0];
    outcome = proposalIds.length === 0 ? "nothing" : "proposed";
    const currentConfig = deps.getCurrentConfig
      ? await deps.getCurrentConfig()
      : (await import("../../config/config.js")).getRuntimeConfig();
    if (resolveSkillWorkshopConfig(currentConfig).autonomous.mode === "auto") {
      const { inspectSkillProposal } = await import("./service.js");
      for (const mutatedProposalId of proposalIds) {
        const proposal = await inspectSkillProposal(mutatedProposalId, {
          workspaceDir,
          agentId: foregroundPromptContext.agentId,
        });
        if (
          !proposal ||
          proposal.record.status !== "pending" ||
          proposal.record.autonomousCapture !== true
        ) {
          continue;
        }
        const autonomous = await applyAutonomousSkillProposal({
          workspaceDir,
          agentId: foregroundPromptContext.agentId,
          config: currentConfig,
          proposal,
          reason: "Autonomous self-learning capture",
        });
        if (autonomous.status === "applied") {
          outcome = "applied";
        }
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
    recordSkillExperienceReviewOutcome(workspaceDir, {
      attemptedAtMs,
      outcome: "failed",
      error: String(error).slice(0, 300),
    });
    throw error;
  } finally {
    clearAgentRunContext(runId);
  }
  recordSkillExperienceReviewOutcome(workspaceDir, {
    attemptedAtMs,
    outcome,
    ...(proposalId ? { proposalId } : {}),
    ...(usage ? { usage } : {}),
  });
}
