import type { EmbeddedForegroundPromptContext } from "../../agents/embedded-agent-runner/run/params.js";
import { runOutsidePreparedModelRuntimePluginGenerationScope } from "../../agents/prepared-model-runtime-generation-scope.js";
import { getCanonicalSkillWorkspace } from "../../agents/skill-workshop-workspace-context.js";
import type { TranscriptEntryAnchor } from "../../config/sessions/transcript-entry-anchor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { RunSkillUsage } from "../runtime/run-usage.js";
import { resolveSkillWorkshopConfig } from "./config.js";
import {
  countSkillModelIterations,
  selectCurrentSkillTurnMessages,
} from "./experience-review-prompt.js";

const EXPERIENCE_REVIEW_MIN_MODEL_ITERATIONS = 10;
const EXPERIENCE_REVIEW_IDLE_MS = 30_000;
const EXPERIENCE_REVIEW_RETRY_IDLE_MS = 30_000;
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
  config: OpenClawConfig;
  source?: TranscriptEntryAnchor;
};

export type ExperienceReviewCandidate = {
  ctx: Pick<ExperienceReviewAgentContext, "runId" | "authProfileId" | "foregroundPromptContext"> & {
    workspaceDir: string;
    modelProviderId: string;
    modelId: string;
  };
  config: OpenClawConfig;
  source: TranscriptEntryAnchor;
  usedSkills?: readonly RunSkillUsage[];
  turnAborted?: boolean;
};

type ExperienceReviewTimer = ReturnType<typeof setTimeout>;

type ExperienceReviewSchedulerDeps = {
  isSystemActive: () => boolean | Promise<boolean>;
  runReview: (candidate: ExperienceReviewCandidate) => Promise<void>;
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
            await deps.runReview(pending.candidate);
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
      const { source } = params;
      const modelProviderId = params.ctx.modelProviderId?.trim();
      const modelId = params.ctx.modelId?.trim();
      if (!source || !modelProviderId || !modelId) {
        return;
      }
      if (!existing && pendingBySession.size >= EXPERIENCE_REVIEW_MAX_PENDING) {
        const oldest = pendingBySession.entries().next().value;
        if (oldest) {
          if (oldest[1].timer) {
            clearTimer(oldest[1].timer);
          }
          pendingBySession.delete(oldest[0]);
        }
      }
      const candidate: ExperienceReviewCandidate = {
        ctx: {
          runId: params.ctx.runId,
          workspaceDir,
          modelProviderId,
          modelId,
          authProfileId: params.ctx.authProfileId,
          foregroundPromptContext: params.ctx.foregroundPromptContext,
        },
        config: params.config,
        source: { ...source },
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
