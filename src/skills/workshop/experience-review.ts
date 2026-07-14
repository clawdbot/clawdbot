import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChatType } from "../../channels/chat-type.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { CommandLane } from "../../process/lanes.js";
import { resolveSkillWorkshopConfig } from "./config.js";
import {
  buildSkillExperienceReviewPrompt,
  formatSkillExperienceReviewTranscript,
} from "./experience-review-prompt.js";

const EXPERIENCE_REVIEW_MIN_MODEL_ITERATIONS = 10;
const EXPERIENCE_REVIEW_IDLE_MS = 30_000;
const EXPERIENCE_REVIEW_RETRY_IDLE_MS = 30_000;
const EXPERIENCE_REVIEW_TIMEOUT_MS = 120_000;
const EXPERIENCE_REVIEW_MAX_PENDING = 32;
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
};

type ExperienceReviewAgentContext = {
  agentId?: string;
  runId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  modelProviderId?: string;
  modelId?: string;
  authProfileId?: string;
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
  config?: OpenClawConfig;
};

export type ExperienceReviewCandidate = {
  ctx: ExperienceReviewAgentContext;
  config?: OpenClawConfig;
  transcript: string;
  modelIterations: number;
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

function currentTurnMessages(messages: readonly unknown[]): readonly unknown[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message &&
      typeof message === "object" &&
      !Array.isArray(message) &&
      (message as { role?: unknown }).role === "user"
    ) {
      return messages.slice(index);
    }
  }
  return messages;
}

function countModelIterations(messages: readonly unknown[]): number {
  return messages.reduce<number>((count, message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return count;
    }
    return count + ((message as { role?: unknown }).role === "assistant" ? 1 : 0);
  }, 0);
}

export async function prepareSkillExperienceReviewCandidate(
  candidate: ExperienceReviewCandidate,
  config: OpenClawConfig,
): Promise<ExperienceReviewCandidate | undefined> {
  if (!resolveSkillWorkshopConfig(config).autonomous.enabled) {
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
            pendingBySession.delete(sessionKey);
            await deps.runReview(candidate);
          } finally {
            reviewInFlight = false;
          }
        })
        .catch((error: unknown) => {
          log.warn(`skill experience review failed: ${String(error)}`);
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
      if (
        existing &&
        !params.event.success &&
        params.ctx.runId?.trim() &&
        params.ctx.runId === existing.candidate.ctx.runId
      ) {
        if (existing.timer) {
          clearTimer(existing.timer);
        }
        pendingBySession.delete(sessionKey);
        return;
      }
      // Quiet time follows all later foreground work in the session. Candidate
      // eligibility only decides whether that completion can replace the evidence.
      if (existing) {
        arm(sessionKey, existing, EXPERIENCE_REVIEW_IDLE_MS);
      }
      if (!resolveSkillWorkshopConfig(params.config).autonomous.enabled) {
        return;
      }
      if (!isEligibleContext(params.ctx)) {
        return;
      }
      const workspaceDir = params.ctx.workspaceDir?.trim();
      if (!workspaceDir) {
        return;
      }

      const turnMessages = currentTurnMessages(params.event.messages);
      const modelIterations = countModelIterations(turnMessages);
      if (params.event.success && modelIterations >= EXPERIENCE_REVIEW_MIN_MODEL_ITERATIONS) {
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
          transcript: formatSkillExperienceReviewTranscript(turnMessages),
          modelIterations,
        };
        const pending = existing ?? { candidate, generation: 0 };
        pending.candidate = candidate;
        pendingBySession.set(sessionKey, pending);
        arm(sessionKey, pending, EXPERIENCE_REVIEW_IDLE_MS);
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
): Promise<void> {
  const workspaceDir = candidate.ctx.workspaceDir;
  const sessionKey = candidate.ctx.sessionKey;
  const modelProviderId = candidate.ctx.modelProviderId?.trim();
  const modelId = candidate.ctx.modelId?.trim();
  if (!workspaceDir || !sessionKey || !modelProviderId || !modelId) {
    return;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-review-"));
  try {
    const sessionId = randomUUID();
    const reviewSessionKey = `agent:${candidate.ctx.agentId ?? "main"}:${EXPERIENCE_REVIEW_SESSION_SEGMENT}:${sessionId}`;
    const { runEmbeddedAgent } = await import("../../agents/embedded-agent.js");
    await runEmbeddedAgent({
      sessionId,
      sessionKey: reviewSessionKey,
      sandboxSessionKey: sessionKey,
      sessionFile: path.join(tempDir, "session.jsonl"),
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
      ...(candidate.config ? { config: candidate.config } : {}),
      prompt: buildSkillExperienceReviewPrompt(candidate),
      provider: modelProviderId,
      model: modelId,
      modelSelectionLocked: true,
      modelFallbacksOverride: [],
      ...(candidate.ctx.authProfileId
        ? { authProfileId: candidate.ctx.authProfileId, authProfileIdSource: "user" as const }
        : {}),
      timeoutMs: EXPERIENCE_REVIEW_TIMEOUT_MS,
      runId: `skill-workshop-review:${randomUUID()}`,
      toolsAllow: ["skill_workshop"],
      disableMessageTool: true,
      disableTrajectory: true,
      skillWorkshopProposalOnly: true,
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
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
