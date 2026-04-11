import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedClassifyFailoverReason,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import {
  extractPlanningOnlyPlanDetails,
  isLikelyExecutionAckPrompt,
  resolveAckExecutionFastPathInstruction,
  resolvePlanningOnlyRetryLimit,
  resolvePlanningOnlyRetryInstruction,
  STRICT_AGENTIC_BLOCKED_TEXT,
  resolveReplayInvalidFlag,
  resolveRunLivenessState,
} from "./run/incomplete-turn.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;

describe("runEmbeddedPiAgent incomplete-turn safety", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    mockedGlobalHookRunner.hasHooks.mockImplementation(() => false);
  });

  it("warns before retrying when an incomplete turn already sent a message", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        toolMetas: [],
        didSendViaMessagingTool: true,
        lastAssistant: {
          stopReason: "toolUse",
          errorMessage: "internal retry interrupted tool execution",
          provider: "openai",
          model: "mock-1",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "run-incomplete-turn-messaging-warning",
    });

    expect(mockedClassifyFailoverReason).toHaveBeenCalledTimes(1);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("verify before retrying");
  });

  it("uses explicit agentId without a session key before surfacing the strict-agentic blocked state", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      sessionKey: undefined,
      agentId: "research",
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-strict-agentic-explicit-agent",
      config: {
        agents: {
          defaults: {
            embeddedPi: {
              executionContract: "default",
            },
          },
          list: [
            { id: "main" },
            {
              id: "research",
              embeddedPi: {
                executionContract: "strict-agentic",
              },
            },
          ],
        },
      } as OpenClawConfig,
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(result.payloads).toEqual([
      {
        text: STRICT_AGENTIC_BLOCKED_TEXT,
        isError: true,
      },
    ]);
  });

  it("detects replay-safe planning-only GPT turns", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
      }),
    });

    expect(retryInstruction).toContain("Do not restate the plan");
  });

  it("detects structured bullet-only plans with intent cues as planning-only GPT turns", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [
          "Plan:\n1. I'll inspect the code\n2. I'll patch the issue\n3. I'll run the tests",
        ],
      }),
    });

    expect(retryInstruction).toContain("Do not restate the plan");
  });

  it("does not misclassify ordinary bullet summaries as planning-only", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["1. Parser refactor\n2. Regression coverage\n3. Docs cleanup"],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("does not treat a bare plan heading as planning-only without an intent cue", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["Plan:\n1. Parser refactor\n2. Regression coverage\n3. Docs cleanup"],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("does not retry planning-only detection after tool activity", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
        toolMetas: [{ toolName: "bash", meta: "ls" }],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("does not retry planning-only detection after an item has started", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
        itemLifecycle: {
          startedCount: 1,
          completedCount: 0,
          activeCount: 1,
        },
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("treats update_plan as non-progress for planning-only retry detection", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I'll capture the steps, then take the first tool action."],
        toolMetas: [{ toolName: "update_plan", meta: "status=updated" }],
        itemLifecycle: {
          startedCount: 1,
          completedCount: 1,
          activeCount: 0,
        },
      }),
    });

    expect(retryInstruction).toContain("Act now");
  });

  it("allows one retry by default and two retries for strict-agentic runs", () => {
    expect(resolvePlanningOnlyRetryLimit("default")).toBe(1);
    expect(resolvePlanningOnlyRetryLimit("strict-agentic")).toBe(2);
    expect(STRICT_AGENTIC_BLOCKED_TEXT).toContain("plan-only turns");
    expect(STRICT_AGENTIC_BLOCKED_TEXT).toContain("advanced the task");
  });

  it("detects short execution approval prompts", () => {
    expect(isLikelyExecutionAckPrompt("ok do it")).toBe(true);
    expect(isLikelyExecutionAckPrompt("go ahead")).toBe(true);
    expect(isLikelyExecutionAckPrompt("Can you do it?")).toBe(false);
  });

  it("detects short execution approvals across requested locales", () => {
    expect(isLikelyExecutionAckPrompt("نفذها")).toBe(true);
    expect(isLikelyExecutionAckPrompt("mach es")).toBe(true);
    expect(isLikelyExecutionAckPrompt("進めて")).toBe(true);
    expect(isLikelyExecutionAckPrompt("fais-le")).toBe(true);
    expect(isLikelyExecutionAckPrompt("adelante")).toBe(true);
    expect(isLikelyExecutionAckPrompt("vai em frente")).toBe(true);
    expect(isLikelyExecutionAckPrompt("진행해")).toBe(true);
  });

  it("adds an ack-turn fast-path instruction for GPT action turns", () => {
    const instruction = resolveAckExecutionFastPathInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "go ahead",
    });

    expect(instruction).toContain("Do not recap or restate the plan");
  });

  it("extracts structured steps from planning-only narration", () => {
    expect(
      extractPlanningOnlyPlanDetails(
        "I'll inspect the code. Then I'll patch the issue. Finally I'll run tests.",
      ),
    ).toEqual({
      explanation: "I'll inspect the code. Then I'll patch the issue. Finally I'll run tests.",
      steps: ["I'll inspect the code.", "Then I'll patch the issue.", "Finally I'll run tests."],
    });
  });

  it("marks incomplete-turn retries as replay-invalid abandoned runs", () => {
    const attempt = makeAttemptResult({
      assistantTexts: [],
      lastAssistant: {
        stopReason: "toolUse",
        provider: "openai",
        model: "gpt-5.4",
        content: [],
      } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
    });
    const incompleteTurnText = "⚠️ Agent couldn't generate a response. Please try again.";

    expect(resolveReplayInvalidFlag({ attempt, incompleteTurnText })).toBe(true);
    expect(
      resolveRunLivenessState({
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt,
        incompleteTurnText,
      }),
    ).toBe("abandoned");
  });

  it("marks compaction-timeout retries as paused and replay-invalid", () => {
    const attempt = makeAttemptResult({
      promptErrorSource: "compaction",
      timedOutDuringCompaction: true,
    });

    expect(resolveReplayInvalidFlag({ attempt })).toBe(true);
    expect(
      resolveRunLivenessState({
        payloadCount: 0,
        aborted: true,
        timedOut: true,
        attempt,
      }),
    ).toBe("paused");
  });
});
