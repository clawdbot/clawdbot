// Focused incomplete-turn behavior coverage.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  runEmbeddedAgent,
  makeLastAssistant,
  makeBaseRunParams,
  makeRunParams,
  expectWarnMessageWith,
  expectNoWarnMessageWith,
} from "./run.incomplete-turn.test-helpers.js";
import {
  mockedClassifyFailoverReason,
  mockedIsRateLimitAssistantError,
  mockedRunEmbeddedAttempt,
  resetRunIncompleteTurnOwnerMocks,
} from "./run.incomplete-turn.test-support.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import { recoverEmbeddedRunAttempt } from "./run/attempt-recovery.js";
import { resolveSilentToolResultReplyPayload } from "./run/incomplete-turn-resolution.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./run/terminal-outcome.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";
import { createUsageAccumulator } from "./usage-accumulator.js";

describe("runEmbeddedAgent incomplete-turn safety", () => {
  beforeEach(() => {
    resetRunIncompleteTurnOwnerMocks();
  });

  it("counts failed tool results in trace tool summaries", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Done."],
        toolMetas: [
          { toolName: "bash", meta: "exit=1", isError: true },
          { toolName: "bash", meta: "exit=2", isError: true },
          { toolName: "bash", meta: "exit=0" },
        ],
      }),
    );

    const result = await runEmbeddedAgent(makeBaseRunParams("run-tool-summary-failure-count"));

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.meta?.toolSummary).toEqual({
      calls: 3,
      tools: ["bash"],
      failures: 2,
    });
  });

  it("emits the before_agent_run hook block message as the agent payload", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        promptError: new Error("Blocked by before-run policy."),
        promptErrorSource: "hook:before_agent_run",
      }),
    );

    const result = await runEmbeddedAgent(makeBaseRunParams("run-before-agent-run-hook-block"));

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toEqual([{ text: "Blocked by before-run policy.", isError: true }]);
    expect(result.meta?.finalAssistantVisibleText).toBe("Blocked by before-run policy.");
    expect(result.meta?.finalAssistantRawText).toBe("Blocked by before-run policy.");
    expect(result.meta?.finalPromptText).toBeUndefined();
    expect(result.meta?.error).toEqual({
      kind: "hook_block",
      message: "Blocked by before-run policy.",
    });
    expect(result.meta?.livenessState).toBe("blocked");
  });

  it("keeps carried usage ahead of transcript history on before_agent_run hook blocks", async () => {
    const historicalAssistant = makeLastAssistant({
      usage: { input: 128_814, output: 3_000, total: 131_814 },
    });
    const carriedUsage = { input: 42_000, output: 1_000, total: 43_000 };
    const attempt = makeAttemptResult({
      assistantTexts: [],
      promptError: new Error("Blocked by before-run policy."),
      promptErrorSource: "hook:before_agent_run",
      lastAssistant: historicalAssistant,
      currentAttemptAssistant: undefined,
    });
    const terminalState = resolveEmbeddedRunAttemptTerminalState({
      attempt,
      assistant: historicalAssistant,
    });

    const recovery = await recoverEmbeddedRunAttempt({
      runInput: {
        runParams: makeBaseRunParams("run-before-agent-run-hook-block-usage"),
        resolvedSessionKey: "agent:main:test-key",
        startedAtMs: Date.now(),
      },
      preparedRuntime: {
        provider: "openai",
        modelId: "gpt-5.6-luna",
        model: { id: "gpt-5.6-luna" },
        genericCompactionRecoveryAllowed: false,
        snapshot: () => ({
          thinkLevel: "off",
          agentHarness: { id: "codex" },
          outerContextTokenMeta: {},
        }),
      },
      normalizedAttempt: {
        attempt,
        sessionIdUsed: attempt.sessionIdUsed,
        attemptAssistant: historicalAssistant,
        currentAttemptAssistant: undefined,
        currentAttemptCompletedAssistant: undefined,
        terminalState,
        setTerminalLifecycleMeta: vi.fn(),
        attemptCompactionCount: 0,
        activeErrorContext: { provider: "openai", model: "gpt-5.6-luna" },
        resolveReplayInvalidForAttempt: () => false,
        canRestartForLiveSwitch: false,
      },
      runtimePlan: { auth: {} },
      sessionPromptState: { sessionFile: "/tmp/session.jsonl" },
      usageAccumulator: createUsageAccumulator(),
      lastRunPromptUsage: carriedUsage,
    } as never);

    expect(recovery).toMatchObject({
      action: "complete",
      result: {
        meta: {
          agentMeta: { lastCallUsage: carriedUsage, promptTokens: 42_000 },
        },
      },
    });
  });

  it("warns before retrying when an incomplete turn already sent a message", async () => {
    // Delivery evidence means retrying could duplicate user-visible output, so
    // the runner must surface a verify-before-retry payload instead.
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

    const result = await runEmbeddedAgent(
      makeRunParams("run-incomplete-turn-messaging-warning", { model: "gpt-4.1" }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(mockedClassifyFailoverReason).toHaveBeenCalledTimes(1);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("verify before retrying");
  });

  it("surfaces internal aborts after tool-use as visible incomplete-turn failures", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        aborted: true,
        externalAbort: false,
        assistantTexts: [],
        toolMetas: [{ toolName: "web_search", meta: "query=next voice note" }],
        lastAssistant: makeLastAssistant({
          stopReason: "toolUse",
        }),
      }),
    );

    const result = await runEmbeddedAgent(makeRunParams("run-internal-abort-tool-use-incomplete"));

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toEqual([
      { text: "⚠️ Agent couldn't generate a response. Please try again.", isError: true },
    ]);
    expect(result.meta?.livenessState).toBe("abandoned");
  });

  it("does not route caller timeouts through provider failover", async () => {
    const controller = new AbortController();
    const timeoutError = new Error("caller deadline elapsed");
    timeoutError.name = "TimeoutError";
    const setTerminalLifecycleMeta = vi.fn();
    const interruptedAssistant = makeLastAssistant({
      stopReason: "error",
      errorMessage: "HTTP 429 Too Many Requests",
    });
    mockedClassifyFailoverReason.mockReturnValue("rate_limit");
    mockedIsRateLimitAssistantError.mockReturnValue(true);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async () => {
      controller.abort(timeoutError);
      return makeAttemptResult({
        assistantTexts: [],
        lastAssistant: interruptedAssistant,
        currentAttemptAssistant: interruptedAssistant,
        setTerminalLifecycleMeta,
      });
    });

    const result = await runEmbeddedAgent(
      makeBaseRunParams("run-caller-timeout", { abortSignal: controller.signal }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads?.at(-1)?.text).toContain("timed out");
    expect(result.meta?.aborted).toBe(false);
    expect(result.meta?.timeoutPhase).toBeUndefined();
    expect(result.meta?.providerStarted).toBeUndefined();
    const lifecycleMeta = setTerminalLifecycleMeta.mock.lastCall?.[0];
    expect(lifecycleMeta).toMatchObject({
      aborted: false,
      livenessState: "blocked",
      stopReason: "timeout",
    });
    expect(lifecycleMeta).not.toHaveProperty("timeoutPhase");
    expect(lifecycleMeta).not.toHaveProperty("providerStarted");
  });

  it("does not synthesize an incomplete turn for a caller abort before attempt flags settle", async () => {
    const controller = new AbortController();
    const abortError = new Error("caller cancelled");
    abortError.name = "AbortError";
    const setTerminalLifecycleMeta = vi.fn();
    const lateAssistant = makeLastAssistant({
      content: [{ type: "text", text: "Late answer" }],
    });
    mockedRunEmbeddedAttempt.mockImplementationOnce(async () => {
      controller.abort(abortError);
      return makeAttemptResult({
        assistantTexts: ["Late answer"],
        lastAssistant: lateAssistant,
        currentAttemptAssistant: lateAssistant,
        setTerminalLifecycleMeta,
      });
    });

    const result = await runEmbeddedAgent(
      makeBaseRunParams("run-caller-abort", { abortSignal: controller.signal }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toBeUndefined();
    expect(result.meta?.aborted).toBe(true);
    expect(result.meta?.error).toBeUndefined();
    expectNoWarnMessageWith("incomplete turn detected");
    expect(setTerminalLifecycleMeta.mock.lastCall?.[0]).toMatchObject({
      aborted: true,
      livenessState: "blocked",
      stopReason: "aborted",
    });
  });

  it("propagates canonical assistant aborts into terminal lifecycle metadata", async () => {
    const setTerminalLifecycleMeta = vi.fn();
    const abortedAssistant = makeLastAssistant({
      stopReason: "aborted",
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: abortedAssistant,
        currentAttemptAssistant: abortedAssistant,
        setTerminalLifecycleMeta,
      }),
    );

    const result = await runEmbeddedAgent(makeBaseRunParams("run-canonical-assistant-abort"));

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.meta?.aborted).toBe(true);
    expect(setTerminalLifecycleMeta.mock.lastCall?.[0]).toMatchObject({
      aborted: true,
    });
  });

  it("synthesizes a silent cron payload from a trailing current-attempt NO_REPLY tool result", () => {
    // Cron no-reply can be represented by a tool result rather than assistant
    // text, but only when it belongs to the current attempt.
    const payload = resolveSilentToolResultReplyPayload({
      isCronTrigger: true,
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "exec" }],
        messagesSnapshot: [
          {
            role: "toolResult",
            content: [{ type: "text", text: "NO_REPLY" }],
            details: { aggregated: "NO_REPLY" },
          } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
          makeLastAssistant({
            model: "gpt-5.4",
          }),
        ],
      }),
    });

    expect(payload).toEqual({ text: "NO_REPLY" });
  });

  it("does not reuse an older NO_REPLY tool result without current-attempt tool activity", () => {
    const payload = resolveSilentToolResultReplyPayload({
      isCronTrigger: true,
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        toolMetas: [],
        messagesSnapshot: [
          {
            role: "toolResult",
            content: [{ type: "text", text: "NO_REPLY" }],
          } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
          {
            role: "user",
            content: [{ type: "text", text: "Current cron prompt" }],
          } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
          makeLastAssistant({
            model: "gpt-5.4",
          }),
        ],
      }),
    });

    expect(payload).toBeNull();
  });

  it("treats exact NO_REPLY tool output as a quiet cron success when the final assistant is empty", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "exec" }],
        messagesSnapshot: [
          {
            role: "toolResult",
            content: [{ type: "text", text: "NO_REPLY" }],
            details: { aggregated: "NO_REPLY" },
          } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
          makeLastAssistant({
            model: "gpt-5.4",
          }),
        ],
        lastAssistant: makeLastAssistant({
          model: "gpt-5.4",
        }),
      }),
    );

    const result = await runEmbeddedAgent(
      makeRunParams("run-cron-no-reply-empty-final", { trigger: "cron", model: "gpt-5.4" }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toEqual([{ text: "NO_REPLY" }]);
    expect(result.meta.livenessState).toBe("working");
    expectNoWarnMessageWith("incomplete turn detected");
  });

  it("surfaces the latest tool-authored presentation after a structured incomplete turn", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams: unknown) => {
      (
        attemptParams as {
          onToolOutcome?: (observation: {
            toolName: string;
            argsHash: string;
            resultHash: string;
            terminalPresentation?: string;
          }) => void;
        }
      ).onToolOutcome?.({
        toolName: "web_fetch",
        argsHash: "args",
        resultHash: "result",
        terminalPresentation: "Web fetch completed.\nOrigin: https://example.com\nStatus: 200",
      });
      return makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "web_fetch" }],
        lastAssistant: makeLastAssistant({
          stopReason: "toolUse",
          model: "gpt-5.4",
        }),
      });
    });

    const result = await runEmbeddedAgent(
      makeRunParams("run-structured-terminal-presentation", { model: "gpt-5.4" }),
    );

    expect(result.payloads).toEqual([
      {
        text:
          "Web fetch completed.\nOrigin: https://example.com\nStatus: 200\n\n" +
          "⚠️ Agent couldn't generate a response. Please try again.",
        isError: true,
      },
    ]);
    expect(result.meta.replayInvalid).toBe(true);
    expect(result.meta.livenessState).toBe("abandoned");
    expect(result.meta.error?.fallbackSafe).toBe(true);
    expect(result.meta.error?.terminalPresentation).toBe(true);
    expectWarnMessageWith("surfacing tool-authored terminal presentation");
  });

  it("surfaces read-only cron presentation after a structured incomplete turn", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams: unknown) => {
      (
        attemptParams as {
          onToolOutcome?: (observation: {
            toolName: string;
            argsHash: string;
            resultHash: string;
            terminalPresentation?: string;
          }) => void;
        }
      ).onToolOutcome?.({
        toolName: "cron",
        argsHash: "args",
        resultHash: "result",
        terminalPresentation: "Automations scheduler status.\nEnabled: yes",
      });
      return makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "cron" }],
        replayMetadata: {
          hadPotentialSideEffects: false,
          replaySafe: true,
        },
        lastAssistant: makeLastAssistant({
          stopReason: "toolUse",
          model: "gpt-5.4",
        }),
      });
    });

    const result = await runEmbeddedAgent(
      makeRunParams("run-read-only-cron-terminal-presentation", { model: "gpt-5.4" }),
    );

    expect(result.payloads).toEqual([
      {
        text:
          "Automations scheduler status.\nEnabled: yes\n\n" +
          "⚠️ Agent couldn't generate a response. Please try again.",
        isError: true,
      },
    ]);
    expect(result.meta.error?.fallbackSafe).toBe(true);
    expect(result.meta.error?.terminalPresentation).toBe(true);
  });

  it("preserves a terminal tool presentation across an empty-response retry", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams: unknown) => {
      (
        attemptParams as {
          onToolOutcome?: (observation: {
            toolName: string;
            argsHash: string;
            resultHash: string;
            terminalPresentation?: string;
          }) => void;
        }
      ).onToolOutcome?.({
        toolName: "web_fetch",
        argsHash: "args",
        resultHash: "result",
        terminalPresentation: "Web fetch completed.\nOrigin: https://example.com\nStatus: 200",
      });
      return makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "web_fetch" }],
        lastAssistant: makeLastAssistant({
          stopReason: "end_turn",
          model: "gpt-5.4",
          content: [{ type: "text", text: "" }],
        }),
      });
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: makeLastAssistant({
          stopReason: "end_turn",
          model: "gpt-5.4",
          content: [{ type: "text", text: "" }],
        }),
      }),
    );

    const result = await runEmbeddedAgent(
      makeRunParams("run-preserved-terminal-presentation", { model: "gpt-5.4" }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads).toEqual([
      {
        text:
          "Web fetch completed.\nOrigin: https://example.com\nStatus: 200\n\n" +
          "⚠️ Agent couldn't generate a response. Please try again.",
        isError: true,
      },
    ]);
  });
});
