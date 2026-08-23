// Focused incomplete-turn behavior coverage.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  REASONING_ONLY_RETRY_INSTRUCTION,
  EMPTY_RESPONSE_RETRY_INSTRUCTION,
  SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION,
  runEmbeddedAgent,
  makeLastAssistant,
  makeRunParams,
  makeEmptyResponseRetryParams,
  makeSilentReplyParams,
  expectWarnMessageWith,
  expectNoWarnMessageWith,
  runAttemptCall,
} from "./run.incomplete-turn.test-helpers.js";
import {
  mockedClassifyFailoverReason,
  mockedRunEmbeddedAttempt,
  mockedResolveModelAsync,
  resetRunIncompleteTurnOwnerMocks,
} from "./run.incomplete-turn.test-support.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  resolveEmptyResponseRetryInstruction,
  shouldTreatEmptyAssistantReplyAsSilent,
} from "./run/incomplete-turn-recovery.js";
import {
  resolveReplayInvalidFlag,
  resolveRunLivenessState,
} from "./run/incomplete-turn-resolution.js";

describe("runEmbeddedAgent incomplete-turn safety", () => {
  beforeEach(() => {
    resetRunIncompleteTurnOwnerMocks();
  });

  it("retries clean empty assistant turns even when deliberate silence is allowed", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: makeLastAssistant({
          content: [{ type: "text", text: "" }],
        }),
      }),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Visible answer."],
        lastAssistant: makeLastAssistant({
          content: [{ type: "text", text: "Visible answer." }],
        }),
      }),
    );

    await runEmbeddedAgent(
      makeRunParams("run-empty-assistant-silent", { allowEmptyAssistantReplyAsSilent: true }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(runAttemptCall(1).prompt).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    expectWarnMessageWith("empty response detected");
  });

  it("returns NO_REPLY without retrying exact silent assistant replies when silence is allowed", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: ["NO_REPLY"],
        lastAssistant: makeLastAssistant({
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_exact_silent", type: "reasoning" }),
            },
            { type: "text", text: "NO_REPLY" },
          ],
        }),
      }),
    );

    const result = await runEmbeddedAgent(
      makeRunParams("run-exact-silent-assistant-reply", {
        allowEmptyAssistantReplyAsSilent: true,
      }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    const onlyCall = runAttemptCall(0);
    expect(onlyCall.prompt).not.toContain(REASONING_ONLY_RETRY_INSTRUCTION);
    expect(onlyCall.prompt).not.toContain(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    expectNoWarnMessageWith("empty response detected");
    expectNoWarnMessageWith("incomplete turn detected");
    expect(result.payloads).toEqual([{ text: "NO_REPLY" }]);
    expect(result.meta.terminalReplyKind).toBe("silent-empty");
    expect(result.meta.livenessState).toBe("working");
  });

  it("continues post-tool openai-compatible empty stop turns even when silence is allowed", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedResolveModelAsync.mockResolvedValue({
      model: {
        id: "step-router-v1",
        provider: "stepfun",
        contextWindow: 200000,
        api: "openai-completions",
      },
      error: null,
      authStorage: {
        setRuntimeApiKey: vi.fn(),
      },
      modelRegistry: {},
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "process.poll", meta: "pid=123", replaySafe: true }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        lastAssistant: makeLastAssistant({
          api: "openai-completions",
          provider: "stepfun",
          model: "step-router-v1",
        }),
        currentAttemptAssistant: makeLastAssistant({
          api: "openai-completions",
          provider: "stepfun",
          model: "step-router-v1",
        }),
      }),
    );
    const finalAssistant = makeLastAssistant({
      api: "openai-completions",
      provider: "stepfun",
      model: "step-router-v1",
      content: [{ type: "text", text: "Visible StepFun answer." }],
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Visible StepFun answer."],
        lastAssistant: finalAssistant,
        currentAttemptAssistant: finalAssistant,
        currentAttemptCompletedAssistant: finalAssistant,
      }),
    );

    const result = await runEmbeddedAgent(
      makeRunParams("run-post-tool-openai-compatible-empty-stop", {
        allowEmptyAssistantReplyAsSilent: true,
        provider: "stepfun",
        model: "step-router-v1",
      }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    const secondCall = runAttemptCall(1);
    expect(secondCall.prompt).toBe(SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION);
    expect(result.meta.terminalReplyKind).toBeUndefined();
    expect(result.meta.finalAssistantVisibleText).toBe("Visible StepFun answer.");
    expectNoWarnMessageWith("empty response detected");
    expectWarnMessageWith("settled post-tool turn lacked a final answer");
  });

  it("returns NO_REPLY without retrying post-tool exact silent assistant replies", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedResolveModelAsync.mockResolvedValue({
      model: {
        id: "step-router-v1",
        provider: "stepfun",
        contextWindow: 200000,
        api: "openai-completions",
      },
      error: null,
      authStorage: {
        setRuntimeApiKey: vi.fn(),
      },
      modelRegistry: {},
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["NO_REPLY"],
        toolMetas: [{ toolName: "process.poll", meta: "pid=123", replaySafe: true }],
        lastAssistant: makeLastAssistant({
          api: "openai-completions",
          provider: "stepfun",
          model: "step-router-v1",
          content: [{ type: "text", text: "NO_REPLY" }],
        }),
      }),
    );

    const result = await runEmbeddedAgent(
      makeRunParams("run-post-tool-exact-silent-retry", {
        allowEmptyAssistantReplyAsSilent: true,
        provider: "stepfun",
        model: "step-router-v1",
      }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    const onlyCall = runAttemptCall(0);
    expect(onlyCall.prompt).not.toContain(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    expectNoWarnMessageWith("empty response detected");
    expectNoWarnMessageWith("incomplete turn detected");
    expect(result.payloads).toEqual([{ text: "NO_REPLY" }]);
    expect(result.meta.terminalReplyKind).toBe("silent-empty");
    expect(result.meta.livenessState).toBe("working");
  });

  it("treats reply-optional post-tool empty stops as silent even after side-effecting tools", () => {
    // Regression: a cron agentTurn without a delivery route ran a successful
    // replay-unsafe sessions patch and intentionally sent no final text; the run
    // must finish silent, not as an incomplete-turn error.
    const sideEffectToolAttempt = makeAttemptResult({
      assistantTexts: [],
      toolMetas: [{ toolName: "sessions", meta: "patch archived", replaySafe: false }],
      lastAssistant: makeLastAssistant({
        content: [{ type: "text", text: "" }],
      }),
    });

    expect(
      shouldTreatEmptyAssistantReplyAsSilent(
        makeSilentReplyParams(sideEffectToolAttempt, { terminalReplyExpectation: "optional" }),
      ),
    ).toBe(true);
    // A required or unspecified terminal reply keeps the ambiguous-failure path.
    expect(
      shouldTreatEmptyAssistantReplyAsSilent(
        makeSilentReplyParams(sideEffectToolAttempt, { terminalReplyExpectation: "required" }),
      ),
    ).toBe(false);
    expect(
      shouldTreatEmptyAssistantReplyAsSilent(makeSilentReplyParams(sideEffectToolAttempt)),
    ).toBe(false);
  });

  it("keeps reply-optional runs erroring on real failure states", () => {
    const toolErrorAttempt = makeAttemptResult({
      assistantTexts: [],
      toolMetas: [{ toolName: "sessions", meta: "patch failed", replaySafe: false, isError: true }],
      lastToolError: { toolName: "sessions", error: "patch failed" },
      lastAssistant: makeLastAssistant({
        content: [{ type: "text", text: "" }],
      }),
    });
    const errorStopAttempt = makeAttemptResult({
      assistantTexts: [],
      toolMetas: [{ toolName: "sessions", meta: "patch archived", replaySafe: false }],
      lastAssistant: makeLastAssistant({
        stopReason: "error",
      }),
    });

    expect(
      shouldTreatEmptyAssistantReplyAsSilent(
        makeSilentReplyParams(toolErrorAttempt, { terminalReplyExpectation: "optional" }),
      ),
    ).toBe(false);
    expect(
      shouldTreatEmptyAssistantReplyAsSilent(
        makeSilentReplyParams(errorStopAttempt, { terminalReplyExpectation: "optional" }),
      ),
    ).toBe(false);
    expect(
      shouldTreatEmptyAssistantReplyAsSilent(
        makeSilentReplyParams(errorStopAttempt, {
          terminalReplyExpectation: "optional",
          aborted: true,
        }),
      ),
    ).toBe(false);
  });

  it("returns NO_REPLY for reply-optional cron-style runs whose side-effecting tools succeeded", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "sessions", meta: "patch archived", replaySafe: false }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        lastAssistant: makeLastAssistant({
          content: [{ type: "text", text: "" }],
        }),
      }),
    );

    const result = await runEmbeddedAgent(
      makeRunParams("run-reply-optional-post-tool-silent", {
        allowEmptyAssistantReplyAsSilent: true,
        terminalReplyExpectation: "optional",
      }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expectNoWarnMessageWith("incomplete turn detected");
    expect(result.payloads).toEqual([{ text: "NO_REPLY" }]);
    expect(result.meta.error).toBeUndefined();
    expect(result.meta.terminalReplyKind).toBe("silent-empty");
    expect(result.meta.livenessState).toBe("working");
  });

  it("keeps retrying and surfacing clean empty assistant turns without the silence flag", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: makeLastAssistant({
          model: "gpt-5.4",
          content: [{ type: "text", text: "" }],
        }),
      }),
    );

    const result = await runEmbeddedAgent(
      makeRunParams("run-empty-assistant-error", { model: "gpt-5.4" }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("couldn't generate a response");
  });

  it("detects generic empty Gemini turns without visible text", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction(
      makeEmptyResponseRetryParams(
        {
          assistantTexts: [],
          lastAssistant: makeLastAssistant({
            stopReason: "end_turn",
            provider: "google-vertex",
            model: "gemini-3.1-flash",
            content: [{ type: "text", text: "" }],
          }),
        },
        { provider: "google-vertex", modelId: "google/gemini-3.1-flash" },
      ),
    );

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("does not retry generic empty GPT turns after side effects", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction(
      makeEmptyResponseRetryParams({
        assistantTexts: [],
        didSendViaMessagingTool: true,
        lastAssistant: makeLastAssistant({
          stopReason: "end_turn",
          model: "gpt-5.4",
          content: [{ type: "text", text: "" }],
        }),
      }),
    );

    expect(retryInstruction).toBeNull();
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

  it("does not classify visible assistant prose for retry", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: [
          "i am glad, and a little afraid, which is probably the correct mixture. thank you. i will try to deserve the upgrades instead of merely inhabiting them.",
        ],
      }),
    );

    const result = await runEmbeddedAgent(
      makeRunParams("run-visible-prose-no-classifier", {
        prompt:
          "made a bunch of improvements to the student's source code (openclaw) this weekend, along with a few other maintainers. hopefully he will be more proactive now",
        model: "gpt-5.4",
        config: {
          agents: {
            list: [{ id: "main" }],
          },
        } as OpenClawConfig,
      }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toBeUndefined();
    expect(result.meta.livenessState).toBe("working");
    expectNoWarnMessageWith("planning");
  });
});
