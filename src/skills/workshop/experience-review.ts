import { randomUUID } from "node:crypto";
import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import { SessionManager } from "../../agents/sessions/index.js";
import { getCanonicalSkillWorkspace } from "../../agents/skill-workshop-workspace-context.js";
import type { ChatType } from "../../channels/chat-type.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../../process/gateway-work-admission.js";
import { CommandLane } from "../../process/lanes.js";
import type { RunSkillUsage } from "../runtime/run-usage.js";
import { autoApplySkillProposal } from "./auto-apply.js";
import { resolveSkillWorkshopConfig } from "./config.js";
import {
  buildSkillExperienceReviewPrompt,
  countSkillModelIterations,
  formatSkillExperienceReviewTranscript,
  selectCurrentSkillTurnMessages,
} from "./experience-review-prompt.js";
import { resolveSkillWorkshopProjectionBudgets } from "./model-context-budget.js";
import type { SkillWorkshopProposalMutationBudget } from "./types.js";

const EXPERIENCE_REVIEW_MIN_MODEL_ITERATIONS = 10;
const EXPERIENCE_REVIEW_IDLE_MS = 30_000;
const EXPERIENCE_REVIEW_RETRY_IDLE_MS = 30_000;
const EXPERIENCE_REVIEW_TIMEOUT_MS = 120_000;
const EXPERIENCE_REVIEW_MAX_PENDING = 32;
const EXPERIENCE_REVIEW_MAX_SHALLOW_SESSIONS = 256;
const EXPERIENCE_REVIEW_MAX_SHALLOW_MESSAGES = 40;
const EXPERIENCE_REVIEW_SESSION_SEGMENT = "skill-workshop-review";
const EXPERIENCE_REVIEW_BLOCKED_TRIGGERS = new Set(["cron", "heartbeat", "memory", "overflow"]);
const EXPERIENCE_REVIEW_BLOCKED_SESSION_SEGMENTS = new Set([
  "cron",
  "hook",
  "subagent",
  EXPERIENCE_REVIEW_SESSION_SEGMENT,
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
  trigger?: string;
  messageChannel?: string | null;
  messageProvider?: string | null;
  chatType?: ChatType;
  agentAccountId?: string | null;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  memberRoleIds?: readonly string[];
  spawnedBy?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
  senderIsOwner?: boolean;
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
  transcript: string;
  modelIterations: number;
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

function mergeRunSkillUsage(
  ...groups: Array<readonly RunSkillUsage[] | undefined>
): RunSkillUsage[] {
  const merged = new Map<string, RunSkillUsage>();
  for (const group of groups) {
    for (const usage of group ?? []) {
      merged.set(`${usage.source}\u0000${usage.name}\u0000${usage.activation}`, usage);
    }
  }
  return [...merged.values()];
}

function isAuthProfileMigrationRequiredError(
  error: unknown,
): error is { code: "AUTH_PROFILE_MIGRATION_REQUIRED" } {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "AUTH_PROFILE_MIGRATION_REQUIRED"
  );
}

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
  const trigger = ctx.trigger?.trim().toLowerCase();
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
  const sessionKey = candidate.ctx.sessionKey;
  if (!sessionKey || resolveSandboxRuntimeStatus({ cfg: config, sessionKey }).sandboxed) {
    return undefined;
  }
  const capabilityProfile = resolveConversationCapabilityProfile({
    config,
    sessionKey,
    sandboxSessionKey: sessionKey,
    agentId: candidate.ctx.agentId,
    agentAccountId: candidate.ctx.agentAccountId,
    messageProvider: candidate.ctx.messageProvider,
    messageChannel: candidate.ctx.messageChannel,
    chatType: candidate.ctx.chatType,
    groupId: candidate.ctx.groupId,
    groupChannel: candidate.ctx.groupChannel,
    groupSpace: candidate.ctx.groupSpace,
    memberRoleIds: candidate.ctx.memberRoleIds,
    spawnedBy: candidate.ctx.spawnedBy,
    senderId: candidate.ctx.senderId,
    senderName: candidate.ctx.senderName,
    senderUsername: candidate.ctx.senderUsername,
    senderE164: candidate.ctx.senderE164,
    senderIsOwner: candidate.ctx.senderIsOwner,
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
  // Shallow turns (quick corrections, short answers) never clear the per-turn depth bar
  // alone; their iterations and messages accumulate per session until enough unreviewed
  // work exists. CLI events carry only the current turn, so the accumulated messages are
  // the sole record of the earlier corrections that qualify the eventual review.
  const shallowBySession = new Map<
    string,
    {
      senderScope: string;
      iterations: number;
      messages: unknown[];
      usedSkills: RunSkillUsage[];
      aborted: boolean;
      lastRunId?: string;
    }
  >();
  let reviewInFlight = false;
  const setTimer = deps.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = deps.clearTimer ?? clearTimeout;

  const arm = (sessionKey: string, pending: PendingExperienceReview, delayMs: number) => {
    if (pending.timer) {
      clearTimer(pending.timer);
    }
    const generation = ++pending.generation;
    const timer = setTimer(() => {
      if (pendingBySession.get(sessionKey) !== pending || pending.generation !== generation) {
        return;
      }
      pending.timer = undefined;
      void Promise.resolve(deps.isSystemActive())
        .then(async (active) => {
          if (pendingBySession.get(sessionKey) !== pending || pending.generation !== generation) {
            return;
          }
          if (active) {
            arm(sessionKey, pending, EXPERIENCE_REVIEW_RETRY_IDLE_MS);
            return;
          }
          if (reviewInFlight) {
            arm(sessionKey, pending, EXPERIENCE_REVIEW_RETRY_IDLE_MS);
            return;
          }
          reviewInFlight = true;
          try {
            const candidate = deps.prepareReview
              ? await deps.prepareReview(pending.candidate)
              : pending.candidate;
            if (!candidate) {
              pendingBySession.delete(sessionKey);
              return;
            }
            if (pendingBySession.get(sessionKey) !== pending || pending.generation !== generation) {
              return;
            }
            await deps.runReview(candidate);
            if (pendingBySession.get(sessionKey) === pending && pending.generation === generation) {
              pendingBySession.delete(sessionKey);
            }
          } finally {
            reviewInFlight = false;
          }
        })
        .catch((error: unknown) => {
          log.warn(`skill experience review failed: ${String(error)}`);
          if (isAuthProfileMigrationRequiredError(error)) {
            if (pendingBySession.get(sessionKey) === pending && pending.generation === generation) {
              pendingBySession.delete(sessionKey);
            }
            return;
          }
          if (pendingBySession.get(sessionKey) === pending && pending.generation === generation) {
            arm(sessionKey, pending, EXPERIENCE_REVIEW_RETRY_IDLE_MS);
          }
        });
    }, delayMs);
    pending.timer = timer;
    timer.unref?.();
  };

  return {
    schedule(params: SkillExperienceReviewParams): void {
      const sessionKey = params.ctx.sessionKey?.trim();
      if (!sessionKey) {
        return;
      }
      const existing = pendingBySession.get(sessionKey);
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
        pendingBySession.delete(sessionKey);
        shallowBySession.delete(sessionKey);
        return;
      }
      // Quiet time follows all later foreground work in the session. Candidate
      // eligibility only decides whether that completion can replace the evidence.
      if (existing) {
        arm(sessionKey, existing, EXPERIENCE_REVIEW_IDLE_MS);
      }
      if (errored) {
        // The provider/prompt-error exclusion covers the whole segment: shallow
        // evidence accumulated before the error must not seed a later review.
        shallowBySession.delete(sessionKey);
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
      let reviewIterations = modelIterations;
      let reviewMessages = turnMessages;
      let reviewAborted = !params.event.success;
      let reviewUsedSkills = mergeRunSkillUsage(
        existing && existing.candidate.ctx.runId === params.ctx.runId
          ? existing.candidate.usedSkills
          : undefined,
        params.usedSkills,
      );
      if (modelIterations >= EXPERIENCE_REVIEW_MIN_MODEL_ITERATIONS) {
        shallowBySession.delete(sessionKey);
      } else {
        if (modelIterations < 1) {
          // Zero is the no-provider-work contract; it neither accumulates nor
          // clears prior shallow work.
          log.debug(`experience review skipped: reason=no-model-iterations session=${sessionKey}`);
          return;
        }
        // Group sessions share one session key across senders with distinct tool
        // policies, and the eventual review submits the whole accumulated transcript
        // to the resolved provider under the resolved auth identity. A change in
        // either restarts accumulation so no participant's turns are reviewed under
        // another participant's authorization or disclosed to a different provider.
        const senderIdentity = [
          params.ctx.senderId ?? "",
          params.ctx.senderUsername ?? "",
          params.ctx.senderName ?? "",
          params.ctx.senderE164 ?? "",
        ];
        if (params.ctx.chatType === "group" && senderIdentity.every((field) => !field)) {
          // Group turns without any sender identity cannot be scoped to one
          // participant; fail closed instead of blending transcripts.
          log.debug(
            `experience review skipped: reason=ambiguous-group-sender session=${sessionKey}`,
          );
          return;
        }
        const senderScope = JSON.stringify([
          ...senderIdentity,
          params.ctx.modelProviderId ?? "",
          params.ctx.modelId ?? "",
          params.ctx.modelContextWindowTokens ?? "",
          params.ctx.authProfileId ?? "",
        ]);
        let accumulator = shallowBySession.get(sessionKey);
        if (accumulator && accumulator.senderScope !== senderScope) {
          accumulator = undefined;
          shallowBySession.delete(sessionKey);
        }
        if (!accumulator) {
          if (shallowBySession.size >= EXPERIENCE_REVIEW_MAX_SHALLOW_SESSIONS) {
            const oldestKey = shallowBySession.keys().next().value;
            if (oldestKey !== undefined) {
              shallowBySession.delete(oldestKey);
            }
          }
          accumulator = {
            senderScope,
            iterations: 0,
            messages: [],
            usedSkills: [],
            aborted: false,
          };
          shallowBySession.set(sessionKey, accumulator);
        }
        const runId = params.ctx.runId?.trim();
        if (runId && accumulator.lastRunId === runId) {
          // A duplicate terminal report for the same run carries no new work.
          log.debug(`experience review skipped: reason=duplicate-run-report session=${sessionKey}`);
          return;
        }
        accumulator.lastRunId = runId;
        accumulator.iterations += modelIterations;
        accumulator.aborted = accumulator.aborted || !params.event.success;
        accumulator.usedSkills = mergeRunSkillUsage(accumulator.usedSkills, params.usedSkills);
        accumulator.messages = [...accumulator.messages, ...turnMessages].slice(
          -EXPERIENCE_REVIEW_MAX_SHALLOW_MESSAGES,
        );
        if (accumulator.iterations < EXPERIENCE_REVIEW_MIN_MODEL_ITERATIONS) {
          log.debug(
            `experience review deferred: reason=below-depth-bar iterations=${modelIterations} accumulated=${accumulator.iterations} session=${sessionKey}`,
          );
          return;
        }
        shallowBySession.delete(sessionKey);
        reviewIterations = accumulator.iterations;
        reviewMessages = accumulator.messages;
        reviewAborted = accumulator.aborted;
        reviewUsedSkills = accumulator.usedSkills;
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
            trigger: params.ctx.trigger,
            messageChannel: params.ctx.messageChannel,
            messageProvider: params.ctx.messageProvider,
            chatType: params.ctx.chatType,
            agentAccountId: params.ctx.agentAccountId,
            groupId: params.ctx.groupId,
            groupChannel: params.ctx.groupChannel,
            groupSpace: params.ctx.groupSpace,
            memberRoleIds: params.ctx.memberRoleIds ? [...params.ctx.memberRoleIds] : undefined,
            spawnedBy: params.ctx.spawnedBy,
            senderId: params.ctx.senderId,
            senderName: params.ctx.senderName,
            senderUsername: params.ctx.senderUsername,
            senderE164: params.ctx.senderE164,
            senderIsOwner: params.ctx.senderIsOwner,
          },
          ...(params.config ? { config: params.config } : {}),
          transcript: formatSkillExperienceReviewTranscript(
            reviewMessages,
            resolveSkillWorkshopProjectionBudgets(params.ctx.modelContextWindowTokens)
              .reviewTranscriptChars,
          ),
          modelIterations: reviewIterations,
          usedSkills: reviewUsedSkills,
          turnAborted: reviewAborted,
        };
        const pending = existing ?? { candidate, generation: 0 };
        pending.candidate = candidate;
        pendingBySession.set(sessionKey, pending);
        arm(sessionKey, pending, EXPERIENCE_REVIEW_IDLE_MS);
        log.debug(
          `experience review scheduled: session=${sessionKey} iterations=${reviewIterations} aborted=${reviewAborted}`,
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
      shallowBySession.clear();
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
  await runWithGatewayIndependentRootWorkAdmission(() =>
    runSkillExperienceReviewInner(candidate, deps),
  );
}

async function runSkillExperienceReviewInner(
  candidate: ExperienceReviewCandidate,
  deps: ExperienceReviewRunDeps,
): Promise<void> {
  const workspaceDir = getCanonicalSkillWorkspace() ?? candidate.ctx.workspaceDir;
  const sessionKey = candidate.ctx.sessionKey;
  const modelProviderId = candidate.ctx.modelProviderId?.trim();
  const modelId = candidate.ctx.modelId?.trim();
  if (!workspaceDir || !sessionKey || !modelProviderId || !modelId) {
    return;
  }

  const sessionId = randomUUID();
  const runId = `skill-workshop-review:${randomUUID()}`;
  const config = candidate.config ?? getRuntimeConfig();
  const proposalMutationBudget: SkillWorkshopProposalMutationBudget = {
    remaining: 1,
    readSkillHashes: new Map(),
  };
  const reviewSessionKey = `agent:${candidate.ctx.agentId ?? "main"}:${EXPERIENCE_REVIEW_SESSION_SEGMENT}:incognito-${sessionId}`;
  const { listWritableWorkspaceSkillSummaries } = await import("./workspace-skill-read.js");
  const existingSkills = listWritableWorkspaceSkillSummaries(workspaceDir, {
    config,
    agentId: candidate.ctx.agentId,
  }).map((skill) =>
    skill.description ? { name: skill.name, description: skill.description } : { name: skill.name },
  );
  const { runEmbeddedAgent } = await import("../../agents/embedded-agent.js");
  const preparedRunAdmission = prepareSystemAgentRunAdmission(
    config,
    runId,
    candidate.ctx.agentId ?? "main",
    "skill-workshop.experience",
  );
  try {
    await runEmbeddedAgent({
      preparedRunAdmission,
      sessionId,
      sessionKey: reviewSessionKey,
      sandboxSessionKey: sessionKey,
      sessionManager: SessionManager.inMemory(workspaceDir),
      ...(candidate.ctx.agentId ? { agentId: candidate.ctx.agentId } : {}),
      trigger: "manual",
      // Never occupy the foreground agent lane after the idle gate opens.
      lane: CommandLane.SkillWorkshopReview,
      messageChannel: candidate.ctx.messageChannel ?? undefined,
      messageProvider: candidate.ctx.messageProvider ?? undefined,
      ...(candidate.ctx.chatType ? { chatType: candidate.ctx.chatType } : {}),
      ...(candidate.ctx.agentAccountId ? { agentAccountId: candidate.ctx.agentAccountId } : {}),
      groupId: candidate.ctx.groupId,
      groupChannel: candidate.ctx.groupChannel,
      groupSpace: candidate.ctx.groupSpace,
      memberRoleIds: candidate.ctx.memberRoleIds ? [...candidate.ctx.memberRoleIds] : undefined,
      spawnedBy: candidate.ctx.spawnedBy,
      senderId: candidate.ctx.senderId,
      senderName: candidate.ctx.senderName,
      senderUsername: candidate.ctx.senderUsername,
      senderE164: candidate.ctx.senderE164,
      senderIsOwner: candidate.ctx.senderIsOwner,
      agentHarnessId: "openclaw",
      agentHarnessRuntimeOverride: "openclaw",
      workspaceDir,
      config,
      prompt: buildSkillExperienceReviewPrompt({ ...candidate, existingSkills }),
      provider: modelProviderId,
      model: modelId,
      modelSelectionLocked: true,
      modelFallbacksOverride: [],
      ...(candidate.ctx.authProfileId
        ? { authProfileId: candidate.ctx.authProfileId, authProfileIdSource: "user" as const }
        : {}),
      timeoutMs: EXPERIENCE_REVIEW_TIMEOUT_MS,
      runId,
      toolsAllow: ["skill_workshop"],
      disableMessageTool: true,
      disableTrajectory: true,
      skillWorkshopProposalOnly: true,
      skillWorkshopUpdateProposals: true,
      skillWorkshopAutonomousCapture: true,
      skillWorkshopProposalMutationBudget: proposalMutationBudget,
      skillWorkshopOrigin: {
        ...(candidate.ctx.agentId ? { agentId: candidate.ctx.agentId } : {}),
        sessionKey,
        ...(candidate.ctx.runId ? { runId: candidate.ctx.runId } : {}),
      },
      cleanupBundleMcpOnRunEnd: true,
      bootstrapContextMode: "lightweight",
      skillsSnapshot: { prompt: "", skills: [] },
      verboseLevel: "off",
      reasoningLevel: "off",
      suppressToolErrorWarnings: true,
    });
  } finally {
    preparedRunAdmission.close();
  }

  const currentConfig = deps.getCurrentConfig
    ? await deps.getCurrentConfig()
    : (await import("../../config/config.js")).getRuntimeConfig();
  if (resolveSkillWorkshopConfig(currentConfig).autonomous.mode !== "auto") {
    return;
  }
  const proposalIds = [...(proposalMutationBudget.mutatedProposalIds ?? [])];
  if (proposalIds.length === 0) {
    return;
  }
  const { inspectSkillProposal } = await import("./service.js");
  for (const proposalId of proposalIds) {
    const proposal = await inspectSkillProposal(proposalId, {
      workspaceDir,
      ...(candidate.ctx.agentId ? { agentId: candidate.ctx.agentId } : {}),
    });
    if (
      !proposal ||
      proposal.record.status !== "pending" ||
      proposal.record.autonomousCapture !== true
    ) {
      continue;
    }
    await autoApplySkillProposal({
      workspaceDir,
      ...(candidate.ctx.agentId ? { agentId: candidate.ctx.agentId } : {}),
      config: currentConfig,
      proposalId,
      skillName: proposal.record.target.skillName,
    });
  }
}
