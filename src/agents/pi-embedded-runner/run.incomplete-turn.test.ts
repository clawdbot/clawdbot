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
  buildAttemptReplayMetadata,
  extractPlanningOnlyPlanDetails,
  isLikelyExecutionAckPrompt,
  PLANNING_ONLY_RETRY_INSTRUCTION,
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

  it("emits explicit replayInvalid + blocked liveness state at the strict-agentic blocked exit", async () => {
    // Criterion 4 of the GPT-5.4 parity gate requires every terminal exit path
    // to emit explicit replayInvalid + livenessState. The strict-agentic
    // blocked exit is the exact place where strict-agentic is supposed to be
    // loudest; it must not fall through to "silent disappearance".
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-strict-agentic-blocked-liveness",
      config: {
        agents: {
          defaults: {
            embeddedPi: {
              executionContract: "strict-agentic",
            },
          },
          list: [{ id: "main" }],
        },
      } as OpenClawConfig,
    });

    expect(result.payloads).toEqual([
      {
        text: STRICT_AGENTIC_BLOCKED_TEXT,
        isError: true,
      },
    ]);
    expect(result.meta.livenessState).toBe("blocked");
    expect(result.meta.replayInvalid).toBe(false);
  });

  it("auto-activates strict-agentic for unconfigured GPT-5 openai runs and surfaces the blocked state", async () => {
    // Criterion 1 of the GPT-5.4 parity gate ("no stalls after planning") must
    // cover out-of-the-box installs, not only users who opted in. An
    // unconfigured GPT-5.4 openai run should receive the strict-agentic retry
    // + blocked-state treatment automatically.
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-strict-agentic-auto-activated",
      config: {
        agents: {
          list: [{ id: "main" }],
        },
      } as OpenClawConfig,
    });

    // Two retries (strict-agentic retry cap) plus the original attempt = 3 calls.
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(result.payloads).toEqual([
      {
        text: STRICT_AGENTIC_BLOCKED_TEXT,
        isError: true,
      },
    ]);
    expect(result.meta.livenessState).toBe("blocked");
  });

  it("respects explicit default contract opt-out on GPT-5 openai runs", async () => {
    // Users who explicitly set executionContract: "default" opt out of
    // auto-activated strict-agentic. They keep the old pre-parity-program
    // behavior (1 retry, then fall through to the normal completion path).
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-strict-agentic-explicit-default-optout",
      config: {
        agents: {
          defaults: {
            embeddedPi: {
              executionContract: "default",
            },
          },
          list: [{ id: "main" }],
        },
      } as OpenClawConfig,
    });

    // Default contract: 1 retry then falls through. Should NOT surface the
    // strict-agentic blocked payload.
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    const payloadTexts = (result.payloads ?? []).map((payload) => payload.text ?? "");
    for (const text of payloadTexts) {
      expect(text).not.toContain("plan-only turns");
    }
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
        toolMetas: [
          { toolName: "read", meta: "path=src/index.ts" },
          { toolName: "search", meta: "pattern=runEmbeddedPiAgent" },
        ],
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

  it("applies the planning-only retry guard to prefixed GPT-5 ids", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "  openai/gpt-5.4  ",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
      }),
    });

    expect(retryInstruction).toContain("Do not restate the plan");
  });

  it("applies the ack-turn fast path to broadened GPT-5-family ids", () => {
    const instruction = resolveAckExecutionFastPathInstruction({
      provider: "openai",
      modelId: "gpt-5o-mini",
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

describe("resolvePlanningOnlyRetryInstruction single-action loophole", () => {
  const openaiParams = { provider: "openai", modelId: "gpt-5.4" } as const;

  function makeAttemptWithTools(
    toolNames: string[],
    assistantText: string,
  ): Parameters<typeof resolvePlanningOnlyRetryInstruction>[0]["attempt"] {
    const toolMetas = toolNames.map((toolName) => ({ toolName }));
    return {
      toolMetas,
      assistantTexts: [assistantText],
      lastAssistant: { stopReason: "stop" },
      itemLifecycle: { startedCount: toolNames.length },
      replayMetadata: buildAttemptReplayMetadata({
        toolMetas,
        didSendViaMessagingTool: false,
      }),
      clientToolCall: null,
      yieldDetected: false,
      didSendDeterministicApprovalPrompt: false,
      didSendViaMessagingTool: false,
      lastToolError: null,
    } as unknown as Parameters<typeof resolvePlanningOnlyRetryInstruction>[0]["attempt"];
  }

  it("retries when exactly 1 non-plan tool call plus 'i can do that' prose is detected", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["read"], "I can do that next."),
    });

    expect(result).toBe(PLANNING_ONLY_RETRY_INSTRUCTION);
  });

  it("retries when exactly 1 non-plan tool call plus planning prose is detected", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["read"], "I'll analyze the structure next."),
    });

    expect(result).toBe(PLANNING_ONLY_RETRY_INSTRUCTION);
  });

  it("does not retry when 2+ non-plan tool calls are present", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["read", "search"], "I'll verify the output."),
    });

    expect(result).toBeNull();
  });

  it("does not retry when 1 tool call plus completion language is present", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["read"], "Done. The file looks correct."),
    });

    expect(result).toBeNull();
  });

  it("does not retry when 1 tool call plus 'let me know' handoff is present", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["read"], "Let me know if you need anything else."),
    });

    expect(result).toBeNull();
  });

  it("does not retry when 1 tool call plus an answer-style summary is present", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(
        ["read"],
        "I'll summarize the root cause: the provider auth scope is missing.",
      ),
    });

    expect(result).toBeNull();
  });

  it("does not retry when 1 tool call plus a future-tense description is present", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(
        ["read"],
        "I'll describe the issue: the provider auth scope is missing.",
      ),
    });

    expect(result).toBeNull();
  });

  it("does not retry when 1 safe tool call is followed by answer prose joined with 'and'", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["read"], "I'll explain and recommend a fix."),
    });

    expect(result).toBeNull();
  });

  it("does not retry when 1 tool call plus a bare 'i can do that' reply is present", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["read"], "I can do that."),
    });

    expect(result).toBeNull();
  });

  it("does not retry when the lone tool call already had side effects", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["sessions_spawn"], "I'll continue from there next."),
    });

    expect(result).toBeNull();
  });

  it("does not retry when the lone tool call is unclassified", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["vendor_widget"], "I'll continue from there next."),
    });

    expect(result).toBeNull();
  });
});
