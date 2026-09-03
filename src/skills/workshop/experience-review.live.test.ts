import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { redactAgentDiagnosticPayload } from "../../agents/diagnostic-redaction.js";
import { isLiveTestEnabled } from "../../agents/live-test-helpers.js";
import { resolveAgentRunSessionTarget } from "../../agents/run-session-target.js";
import {
  sanitizeToolCallInputs,
  sanitizeToolUseResultPairingForModel,
} from "../../agents/session-transcript-repair.js";
import { SessionManager } from "../../agents/sessions/index.js";
import { onAgentRuntimeEvent } from "../../infra/agent-events.js";
import type { Message } from "../../llm/types.js";
import { closeOpenClawStateDatabaseByPath } from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import {
  readSkillReviewOutcomes,
  recordSkillExperienceReviewOutcome,
} from "./collection-review-state.js";
import { assertExperienceReviewDecision } from "./experience-review-decision.test-support.js";
import { observeExperienceReview } from "./experience-review-observation.test-support.js";
import { runSkillExperienceReview, type ExperienceReviewCandidate } from "./experience-review.js";
import {
  createExperienceReviewCandidate,
  createExperienceReviewMessages,
} from "./experience-review.test-support.js";
import { getSkillProposalRunProgress, listSkillProposals } from "./service.js";

const LIVE =
  isLiveTestEnabled(["OPENCLAW_LIVE_SKILL_EXPERIENCE_REVIEW"]) &&
  Boolean(process.env.OPENAI_API_KEY?.trim());
const describeLive = LIVE ? describe : describe.skip;
const modelId = process.env.OPENCLAW_LIVE_SKILL_EXPERIENCE_MODEL ?? "gpt-5.6-luna";
const { positiveMessages, negativeMessages, interruptedMessages } =
  createExperienceReviewMessages(modelId);
const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;
let workspaceDir = "";
const reviewDiagnostics = new Map<string, unknown>();
const unsubscribeDiagnostics = LIVE
  ? onAgentRuntimeEvent((event) => {
      if (
        !event.runId.startsWith("skill-workshop-review:") ||
        !["assistant", "tool", "lifecycle", "error"].includes(event.stream)
      ) {
        return;
      }
      const phase = typeof event.data.phase === "string" ? event.data.phase : "";
      const toolCallId = typeof event.data.toolCallId === "string" ? event.data.toolCallId : "";
      const key = `${event.runId}:${event.stream}:${phase}:${toolCallId}`;
      if (reviewDiagnostics.size < 100 || reviewDiagnostics.has(key)) {
        reviewDiagnostics.set(key, {
          runId: event.runId,
          stream: event.stream,
          data: redactAgentDiagnosticPayload(event.data),
        });
      }
    })
  : () => undefined;

beforeAll(async () => {
  // Full home isolation: the embedded review resolves the shared-main auth
  // store via HOME, and a real ~/.openclaw with pending doctor migration
  // must never leak into (or fail) this live run.
  testState = await createOpenClawTestState({
    layout: "home",
    prefix: "openclaw-live-skill-review-state-",
  });
  workspaceDir = await tempDirs.make("openclaw-live-skill-review-workspace-");
});

function logReviewOutcomes(
  reviews: ReturnType<typeof readSkillReviewOutcomes>["experienceReviews"],
) {
  // Persisted failures contain raw provider errors; keep only structured
  // outcome metadata in CI logs, regardless of secret spelling or format.
  const outcomes = Object.fromEntries(
    Object.entries(reviews).map(([key, review]) => [
      key,
      {
        attemptedAtMs: review.attemptedAtMs,
        outcome: review.outcome,
        proposalId: review.proposalId,
        usage: review.usage,
      },
    ]),
  );
  console.log("WORKSHOP_REVIEW_OUTCOMES", JSON.stringify(outcomes));
}

afterAll(async () => {
  unsubscribeDiagnostics();
  if (LIVE) {
    console.log("WORKSHOP_RUNTIME_DIAGNOSTICS", JSON.stringify([...reviewDiagnostics.values()]));
    logReviewOutcomes(readSkillReviewOutcomes().experienceReviews);
  }
  await testState.cleanup();
  await tempDirs.cleanup();
});

async function candidate(
  runId: string,
  messages: Message[],
  options: { turnAborted?: boolean } = {},
): Promise<ExperienceReviewCandidate> {
  return createExperienceReviewCandidate(runId, messages, { workspaceDir, modelId, ...options });
}

describe("skill experience review diagnostics", () => {
  it("logs persisted failure outcomes without raw provider error text", async () => {
    const liveOutcomesBefore = readSkillReviewOutcomes();
    const diagnosticWorkspace = await tempDirs.make("openclaw-live-skill-review-diagnostic-");
    // Workspace keys share one database. Isolate synthetic failures so the
    // live afterAll output contains only outcomes from actual review runs.
    const diagnosticStore = { path: path.join(diagnosticWorkspace, "openclaw.sqlite") };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      recordSkillExperienceReviewOutcome(
        "main",
        diagnosticWorkspace,
        {
          attemptedAtMs: 1,
          outcome: "failed",
          error: "provider rejected Authorization: Bearer synthetic-workshop-credential",
          usage: { inputTokens: 3, cachedInputTokens: 1, outputTokens: 2 },
        },
        diagnosticStore,
      );
      logReviewOutcomes(readSkillReviewOutcomes(diagnosticStore).experienceReviews);
      expect(log).toHaveBeenCalledOnce();
      const [label, json] = log.mock.calls[0]!;
      expect(label).toBe("WORKSHOP_REVIEW_OUTCOMES");
      expect(Object.values(JSON.parse(json))).toContainEqual({
        attemptedAtMs: 1,
        outcome: "failed",
        usage: { inputTokens: 3, cachedInputTokens: 1, outputTokens: 2 },
      });
      expect(json).not.toContain("synthetic-workshop-credential");
      expect(readSkillReviewOutcomes()).toEqual(liveOutcomesBefore);
    } finally {
      log.mockRestore();
      closeOpenClawStateDatabaseByPath(diagnosticStore.path);
    }
  });
});

describe("skill experience review transcript fixture", () => {
  it.each([
    ["positive", positiveMessages],
    ["negative", negativeMessages],
    ["interrupted", interruptedMessages],
  ] as const)("preserves %s evidence through canonical transcript replay", async (name, build) => {
    const runId = `transcript-fixture-${name}`;
    const sessionId = `live-skill-review-${runId}`;
    const sessionKey = `agent:main:${sessionId}`;
    const messages = build();
    const seeded = await candidate(runId, messages);
    const target = await resolveAgentRunSessionTarget({
      agentId: "main",
      config: seeded.config,
      missingSessionKey: "resolve-existing",
      sessionId,
      sessionKey,
    });
    const stored = SessionManager.open(target, workspaceDir).buildSessionContext().messages;
    expect(stored).toEqual(messages);

    // The review replays native tools. Invented tool names lose their calls
    // and orphaned results, removing the recovery evidence from the evaluation.
    const replay = sanitizeToolUseResultPairingForModel(
      sanitizeToolCallInputs(stored, { allowedToolNames: ["exec", "read", "skill_workshop"] }),
      true,
    );
    expect(replay.filter((message) => message.role === "toolResult")).toEqual(
      expect.arrayContaining(messages.filter((message) => message.role === "toolResult")),
    );
  });
});

describeLive("skill experience review live OpenAI eval", () => {
  beforeAll(async () => {
    // Warm the plugin runtime outside the review lane: the first load compiles
    // extensions synchronously and can exceed the lane's no-progress watchdog
    // on a loaded machine.
    const { loadAgentRuntimePluginRegistryHandle } =
      await import("../../agents/runtime-plugins.js");
    const warmupCandidate = await candidate("warmup", []);
    loadAgentRuntimePluginRegistryHandle({
      config: warmupCandidate.config ?? {},
      workspaceDir,
    });
  }, 600_000);

  it("completes real reviews with proposal receipts or explicit abstention", async () => {
    for (const [name, build, turnAborted] of [
      ["positive", positiveMessages, false],
      ["negative", negativeMessages, false],
      ["interrupted", interruptedMessages, true],
    ] as const) {
      const runId = `live-${name}`;
      const messages = build();
      const reviewCandidate = await candidate(runId, messages, { turnAborted });
      const before = await listSkillProposals();
      const startedAt = Date.now();
      const observation = await observeExperienceReview(() =>
        runSkillExperienceReview(reviewCandidate, {
          getCurrentConfig: () => reviewCandidate.config ?? {},
        }),
      );
      const { proposals } = await listSkillProposals();
      const progress = await getSkillProposalRunProgress({ runId });
      const outcomes = Object.values(readSkillReviewOutcomes().experienceReviews);
      expect(outcomes).toHaveLength(1);
      const decision = assertExperienceReviewDecision({
        observation,
        // Responses replay adds an explicit aborted result for the interrupted
        // fixture's unfinished call; retain every original body in exact order.
        messages: sanitizeToolUseResultPairingForModel(messages, true),
        progress,
        proposals,
        outcome: outcomes[0],
        startedAt,
      });
      if (decision === "abstained") {
        expect(proposals).toEqual(before.proposals);
      }
      if (name === "negative") {
        expect(decision).toBe("abstained");
      }
      console.log(
        "WORKSHOP_LIVE_DECISION",
        JSON.stringify({ case: name, decision, mutationCount: progress.mutationCount }),
      );
    }
  }, 300_000);
});
