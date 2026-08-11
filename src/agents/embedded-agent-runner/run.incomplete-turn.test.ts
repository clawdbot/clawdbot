// Coverage for incomplete-turn safety, retry instructions, and liveness states.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE } from "../../llm/types.js";
import {
  hasCommittedMessagingToolDeliveryEvidence,
  hasOutboundDeliveryEvidence,
} from "./delivery-evidence.js";
import {
  mockedBuildEmbeddedRunPayloads,
  mockedClassifyFailoverReason,
  mockedIsFailoverAssistantError,
  mockedIsRateLimitAssistantError,
  mockedLog,
  mockedRunEmbeddedAttempt,
  mockedResolveModelAsync,
  mockedSleepWithAbort,
  overflowBaseRunParams,
  registerAgentHarness,
  resetRunIncompleteTurnOwnerMocks,
  runIncompleteTurnOwnerHarness,
} from "./run.incomplete-turn.test-support.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import { recoverEmbeddedRunAttempt } from "./run/attempt-recovery.js";
import {
  buildAttemptReplayMetadata,
  DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT,
  DEFAULT_REASONING_ONLY_RETRY_LIMIT,
  resolveEmptyResponseRetryInstruction,
  isIncompleteTerminalAssistantTurn,
  resolveIncompleteTurnPayloadText as resolveIncompleteTurnPayloadTextCore,
  resolveReasoningOnlyRetryInstruction,
  resolveReplayInvalidFlag,
  resolveRunLivenessState,
  resolveSilentToolResultReplyPayload,
  resolveSettledToolTerminalContinuationInstruction,
  shouldRetryMissingAssistantTurn,
  shouldRetrySilentErrorAssistantTurn,
  shouldTreatEmptyAssistantReplyAsSilent,
} from "./run/incomplete-turn.js";
import { normalizeEmbeddedRunAttemptResult } from "./run/run-attempt-result.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./run/terminal-outcome.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";
import { createUsageAccumulator } from "./usage-accumulator.js";

const REASONING_ONLY_RETRY_INSTRUCTION =
  "The previous assistant turn recorded reasoning but did not produce a user-visible answer. Continue from that partial turn and produce the visible answer now. Do not restate the reasoning or restart from scratch.";
const EMPTY_RESPONSE_RETRY_INSTRUCTION =
  "The previous attempt did not produce a user-visible answer. Continue from the current state and produce the visible answer now. Do not restart from scratch.";
const SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION =
  "The previous assistant turn completed its tool calls but did not produce a user-visible answer. Continue from the current transcript and produce the final user-visible answer now. Do not repeat completed tool calls or restart from scratch.";

const runEmbeddedAgent = runIncompleteTurnOwnerHarness;

type LastAssistant = NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;
type AttemptOverrides = Parameters<typeof makeAttemptResult>[0];
type RunParams = Parameters<typeof runEmbeddedAgent>[0];
type LastAssistantFixture = Omit<LastAssistant, "content" | "stopReason" | "usage"> & {
  content: Array<Record<string, unknown>>;
  stopReason: LastAssistant["stopReason"] | "end_turn";
  usage: Partial<LastAssistant["usage"]> & { total?: number };
};

function makeLastAssistant(overrides: Partial<LastAssistantFixture> = {}): LastAssistant {
  return {
    role: "assistant",
    stopReason: "stop",
    provider: "openai",
    model: "gpt-5.5",
    content: [],
    ...overrides,
  } as unknown as LastAssistant;
}

function resolveIncompleteTurnPayloadText(
  params: Omit<Parameters<typeof resolveIncompleteTurnPayloadTextCore>[0], "externalAbort"> & {
    externalAbort?: boolean;
  },
): string | null {
  // Most helper tests exercise internal abort behavior; external aborts opt in
  // explicitly through params.
  return resolveIncompleteTurnPayloadTextCore({ externalAbort: false, ...params });
}

function makeBaseRunParams(runId: string, overrides: Partial<RunParams> = {}): RunParams {
  return { ...overflowBaseRunParams, runId, ...overrides };
}

function makeRunParams(runId: string, overrides: Partial<RunParams> = {}): RunParams {
  return {
    ...overflowBaseRunParams,
    provider: "openai",
    model: "gpt-5.5",
    runId,
    ...overrides,
  };
}

function makeIncompleteTurnParams(
  attemptOverrides: AttemptOverrides = {},
  overrides: Partial<Omit<Parameters<typeof resolveIncompleteTurnPayloadText>[0], "attempt">> = {},
): Parameters<typeof resolveIncompleteTurnPayloadText>[0] {
  return {
    payloadCount: 0,
    aborted: false,
    timedOut: false,
    attempt: makeAttemptResult(attemptOverrides),
    ...overrides,
  };
}

function makeReasoningRetryParams(
  attemptOverrides: AttemptOverrides = {},
  overrides: Partial<
    Omit<Parameters<typeof resolveReasoningOnlyRetryInstruction>[0], "attempt">
  > = {},
): Parameters<typeof resolveReasoningOnlyRetryInstruction>[0] {
  return {
    provider: "openai",
    modelId: "gpt-5.4",
    aborted: false,
    timedOut: false,
    attempt: makeAttemptResult(attemptOverrides),
    ...overrides,
  };
}

function makeEmptyResponseRetryParams(
  attemptOverrides: AttemptOverrides = {},
  overrides: Partial<
    Omit<Parameters<typeof resolveEmptyResponseRetryInstruction>[0], "attempt">
  > = {},
): Parameters<typeof resolveEmptyResponseRetryInstruction>[0] {
  return {
    provider: "openai",
    modelId: "gpt-5.4",
    payloadCount: 0,
    aborted: false,
    timedOut: false,
    attempt: makeAttemptResult(attemptOverrides),
    ...overrides,
  };
}

function makeSettledContinuationParams(
  attemptOverrides: AttemptOverrides = {},
  overrides: Partial<
    Omit<Parameters<typeof resolveSettledToolTerminalContinuationInstruction>[0], "attempt">
  > = {},
): Parameters<typeof resolveSettledToolTerminalContinuationInstruction>[0] {
  return {
    provider: "openai",
    modelId: "gpt-5.5",
    modelApi: "openai-chatgpt-responses",
    payloadCount: 0,
    aborted: false,
    timedOut: false,
    attempt: makeAttemptResult(attemptOverrides),
    ...overrides,
  };
}

function makeSilentReplyParams(
  attempt: EmbeddedRunAttemptResult,
  overrides: Partial<
    Omit<Parameters<typeof shouldTreatEmptyAssistantReplyAsSilent>[0], "attempt">
  > = {},
): Parameters<typeof shouldTreatEmptyAssistantReplyAsSilent>[0] {
  return {
    allowEmptyAssistantReplyAsSilent: true,
    payloadCount: 0,
    aborted: false,
    timedOut: false,
    attempt,
    ...overrides,
  };
}

describe("runEmbeddedAgent incomplete-turn safety", () => {
  beforeEach(() => {
    resetRunIncompleteTurnOwnerMocks();
  });

  function warnMessages(): string[] {
    return mockedLog.warn.mock.calls.map(([message]) => String(message));
  }

  function expectWarnMessageWith(text: string): void {
    expect(warnMessages().join("\n")).toContain(text);
  }

  function expectNoWarnMessageWith(text: string): void {
    expect(warnMessages().join("\n")).not.toContain(text);
  }

  function runAttemptCall(index: number): {
    prompt?: string;
    disableTools?: boolean;
    operation?: string;
    suppressNextUserMessagePersistence?: boolean;
    skipPreparedUserTurnMessage?: boolean;
  } {
    // Continuation prompt assertions read the exact prompt passed to the runner
    // attempt rather than derived result metadata.
    const call = mockedRunEmbeddedAttempt.mock.calls[index];
    if (!call) {
      throw new Error(`Expected run embedded attempt call ${index}`);
    }
    return call[0] as {
      prompt?: string;
      disableTools?: boolean;
      operation?: string;
      suppressNextUserMessagePersistence?: boolean;
      skipPreparedUserTurnMessage?: boolean;
    };
  }

  function markUserMessagePersisted(attemptParams: unknown): void {
    (
      attemptParams as {
        onUserMessagePersisted?: (message: { role: "user"; content: string }) => void;
      }
    ).onUserMessagePersisted?.({ role: "user", content: "test prompt" });
  }

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

  it("keeps model-call order when parallel tool outcomes finish out of order", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams: unknown) => {
      const onToolOutcome = (
        attemptParams as {
          onToolOutcome?: (observation: {
            toolName: string;
            argsHash: string;
            resultHash: string;
            toolCallOrdinal?: number;
            terminalPresentation?: string;
          }) => void;
        }
      ).onToolOutcome;
      onToolOutcome?.({
        toolName: "exec",
        argsHash: "exec-args",
        resultHash: "exec-result",
        toolCallOrdinal: 1,
      });
      onToolOutcome?.({
        toolName: "web_fetch",
        argsHash: "fetch-args",
        resultHash: "fetch-result",
        toolCallOrdinal: 0,
        terminalPresentation: "Web fetch completed.\nOrigin: https://example.com\nStatus: 200",
      });
      return makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "web_fetch" }, { toolName: "exec" }],
        lastAssistant: makeLastAssistant({
          stopReason: "toolUse",
          model: "gpt-5.4",
        }),
      });
    });

    const result = await runEmbeddedAgent(
      makeRunParams("run-stale-terminal-presentation", { model: "gpt-5.4" }),
    );

    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("couldn't generate a response");
    expect(result.meta.error?.fallbackSafe).toBe(false);
  });

  it("does not surface a read-only presentation after a sibling side effect", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams: unknown) => {
      const onToolOutcome = (
        attemptParams as {
          onToolOutcome?: (observation: {
            toolName: string;
            argsHash: string;
            resultHash: string;
            terminalPresentation?: string;
          }) => void;
        }
      ).onToolOutcome;
      onToolOutcome?.({
        toolName: "exec",
        argsHash: "exec-args",
        resultHash: "exec-result",
      });
      onToolOutcome?.({
        toolName: "web_fetch",
        argsHash: "fetch-args",
        resultHash: "fetch-result",
        terminalPresentation: "Web fetch completed.\nOrigin: https://example.com\nStatus: 200",
      });
      return makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "exec" }, { toolName: "web_fetch" }],
        lastAssistant: makeLastAssistant({
          stopReason: "toolUse",
          model: "gpt-5.4",
        }),
      });
    });

    const result = await runEmbeddedAgent(
      makeRunParams("run-side-effect-terminal-presentation", { model: "gpt-5.4" }),
    );

    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("couldn't generate a response");
    expect(result.meta.error?.fallbackSafe).toBe(false);
  });

  it("promotes successful final assistant text when a prompt timeout races completion", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    const finalText =
      "1. Verdict: the answer completed cleanly. 2. Evidence: the runner captured final text.";
    const finalAssistant = makeLastAssistant({
      content: [{ type: "text", text: finalText }],
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        timedOut: true,
        lastAssistant: finalAssistant,
        currentAttemptAssistant: finalAssistant,
      }),
    );

    const result = await runEmbeddedAgent(
      makeRunParams("run-prompt-timeout-final-assistant-recovered"),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toEqual([{ text: finalText }]);
    expect(result.meta.finalAssistantVisibleText).toBe(finalText);
    expect(result.meta.finalAssistantRawText).toBe(finalText);
    expect(result.meta.livenessState).toBe("working");
    expect(result.meta.completion).toEqual({
      stopReason: "stop",
      finishReason: "stop",
    });
    expect(result.meta.executionTrace?.attempts?.at(-1)).toMatchObject({
      result: "success",
      stage: "assistant",
    });
  });

  it("does not recover a stale prior assistant after the current prompt times out", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    const staleAssistant = makeLastAssistant({
      content: [{ type: "text", text: "Stale answer from the prior attempt." }],
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        timedOut: true,
        lastAssistant: staleAssistant,
        currentAttemptAssistant: undefined,
      }),
    );

    const result = await runEmbeddedAgent(makeRunParams("run-prompt-timeout-stale-assistant"));

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads?.some((payload) => payload.text?.includes("timed out"))).toBe(true);
    expect(result.payloads?.some((payload) => payload.text?.includes("Stale answer"))).toBe(false);
    expect(result.meta.finalAssistantVisibleText).toBeUndefined();
  });

  it("does not resolve a successful run from a stale transcript assistant", async () => {
    const staleAssistant = makeLastAssistant({
      content: [{ type: "text", text: "Prior transcript reply." }],
    });
    const completedAssistant = makeLastAssistant({
      content: [{ type: "text", text: "Current run reply." }],
    });
    mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "Current run reply." }]);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Current run reply."],
        lastAssistant: staleAssistant,
        currentAttemptAssistant: staleAssistant,
        currentAttemptCompletedAssistant: completedAssistant,
      }),
    );

    const result = await runEmbeddedAgent(makeRunParams("run-success-stale-transcript-assistant"));

    expect(result.payloads).toEqual([{ text: "Current run reply." }]);
    expect(result.meta.finalAssistantVisibleText).toBe("Current run reply.");
    expect(result.meta.finalAssistantRawText).toBe("Current run reply.");
    expect(mockedBuildEmbeddedRunPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        currentAssistant: completedAssistant,
        lastAssistant: completedAssistant,
      }),
    );
  });

  it("retains the yielded attempt assistant for paused-turn payload classification", async () => {
    const completedAssistant = makeLastAssistant({
      content: [{ type: "text", text: "Earlier completed cycle." }],
    });
    const yieldedAssistant = makeLastAssistant({
      stopReason: "aborted",
      content: [{ type: "toolCall", name: "sessions_yield", arguments: {} }],
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: yieldedAssistant,
        currentAttemptAssistant: undefined,
        currentAttemptCompletedAssistant: completedAssistant,
        yieldDetected: true,
      }),
    );

    const result = await runEmbeddedAgent(makeRunParams("run-yielded-assistant-classification"));

    expect(result.meta).toMatchObject({ livenessState: "paused", yielded: true });
    expect(mockedBuildEmbeddedRunPayloads).toHaveBeenCalledWith(
      expect.objectContaining({ currentAssistant: null, lastAssistant: yieldedAssistant }),
    );
  });

  it("recovers a completed prompt-timeout assistant without collected assistant text", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    const finalText = "Completed answer after the timeout race.";
    const finalAssistant = makeLastAssistant({
      content: [{ type: "text", text: finalText }],
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: undefined as unknown as string[],
        timedOut: true,
        lastAssistant: finalAssistant,
        currentAttemptAssistant: finalAssistant,
      }),
    );

    const result = await runEmbeddedAgent(makeRunParams("run-prompt-timeout-no-assistant-texts"));

    expect(result.payloads).toEqual([{ text: finalText }]);
  });

  it("preserves tool media when prompt-timeout recovery replaces partial assistant text", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    const partialText = "Partial answer before the timeout race.";
    const finalText = "Complete answer after the timeout race.";
    const finalAssistant = makeLastAssistant({
      content: [{ type: "text", text: finalText }],
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [partialText],
        timedOut: true,
        lastAssistant: finalAssistant,
        currentAttemptAssistant: finalAssistant,
        toolMediaUrls: ["https://example.test/recovered-output.png"],
      }),
    );

    const result = await runEmbeddedAgent(
      makeRunParams("run-prompt-timeout-final-assistant-media"),
    );

    expect(result.payloads).toEqual([
      {
        mediaUrl: "https://example.test/recovered-output.png",
        mediaUrls: ["https://example.test/recovered-output.png"],
        audioAsVoice: undefined,
        trustedLocalMedia: undefined,
      },
      { text: finalText },
    ]);
  });

  it("replaces the latest partial assistant payload after prompt-timeout recovery", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    const completedText = "Completed answer block before the final response.";
    const partialText = "Partial final response before the timeout race.";
    const finalText = "Complete final response after the timeout race.";
    mockedBuildEmbeddedRunPayloads.mockReturnValueOnce([
      { text: completedText },
      { text: partialText },
    ]);
    const finalAssistant = makeLastAssistant({
      content: [{ type: "text", text: finalText }],
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [completedText, partialText],
        timedOut: true,
        lastAssistant: finalAssistant,
        currentAttemptAssistant: finalAssistant,
      }),
    );

    const result = await runEmbeddedAgent(makeRunParams("run-prompt-timeout-latest-partial"));

    expect(result.payloads).toEqual([{ text: completedText }, { text: finalText }]);
  });

  it("records same-model rate-limit retries without a profile-rotation trace", async () => {
    const rateLimitMessage =
      "429 rate_limit_exceeded: requests per minute exceeded; Retry-After: 30";
    const rateLimitAssistant = makeLastAssistant({
      stopReason: "error",
      errorMessage: rateLimitMessage,
    });
    mockedClassifyFailoverReason.mockImplementation((raw) =>
      raw.includes("429") ? "rate_limit" : null,
    );
    mockedIsFailoverAssistantError.mockImplementation((assistant) =>
      Boolean(assistant?.errorMessage?.includes("429")),
    );
    mockedIsRateLimitAssistantError.mockImplementation((assistant) =>
      Boolean(assistant?.errorMessage?.includes("429")),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: rateLimitAssistant,
        currentAttemptAssistant: rateLimitAssistant,
      }),
    );
    const recoveredAssistant = makeLastAssistant({
      content: [{ type: "text", text: "Recovered after a short rate-limit wait." }],
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Recovered after a short rate-limit wait."],
        lastAssistant: recoveredAssistant,
        currentAttemptAssistant: recoveredAssistant,
      }),
    );

    const result = await runEmbeddedAgent(makeRunParams("run-same-model-rate-limit-trace"));

    expect(mockedSleepWithAbort).toHaveBeenCalledWith(30_000, undefined);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.meta.executionTrace?.fallbackUsed).toBe(false);
    expect(result.meta.executionTrace?.attempts).toMatchObject([
      {
        provider: "openai",
        model: "gpt-5.5",
        result: "same_model_rate_limit",
        reason: "rate_limit",
        stage: "assistant",
      },
      {
        provider: "openai",
        model: "gpt-5.5",
        result: "success",
        stage: "assistant",
      },
    ]);
  });

  it("retries reasoning-only GPT turns with a visible-answer continuation instruction", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams) => {
      markUserMessagePersisted(attemptParams);
      return makeAttemptResult({
        assistantTexts: [],
        lastAssistant: makeLastAssistant({
          stopReason: "end_turn",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_reasoning_only", type: "reasoning" }),
            },
          ],
        }),
      });
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Visible answer."],
        lastAssistant: makeLastAssistant({
          stopReason: "end_turn",
          model: "gpt-5.4",
          content: [{ type: "text", text: "Visible answer." }],
        }),
      }),
    );

    await runEmbeddedAgent(makeRunParams("run-reasoning-only-continuation", { model: "gpt-5.4" }));

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    const secondCall = runAttemptCall(1);
    expect(secondCall.prompt).toBe(REASONING_ONLY_RETRY_INSTRUCTION);
    expect(secondCall.suppressNextUserMessagePersistence).toBe(false);
    expect(secondCall.skipPreparedUserTurnMessage).toBe(true);
    expectWarnMessageWith("reasoning-only assistant turn detected");
  });

  it("continues once after settled side-effecting tools finish without a final answer", async () => {
    const acceptedSessionSpawns = [
      { runId: "child-run", childSessionKey: "agent:main:subagent:child" },
    ];
    const toolUseAssistant = makeLastAssistant({
      stopReason: "toolUse",
      content: [
        { type: "toolCall", id: "tool_write", name: "write", arguments: { path: "note.txt" } },
        { type: "toolCall", id: "tool_cron", name: "cron", arguments: { action: "add" } },
        {
          type: "toolCall",
          id: "tool_spawn",
          name: "sessions_spawn",
          arguments: { task: "follow up" },
        },
      ],
    });
    const settledToolResults = [
      toolUseAssistant,
      { role: "toolResult", toolCallId: "tool_write", toolName: "write", isError: false },
      { role: "toolResult", toolCallId: "tool_cron", toolName: "cron", isError: false },
      {
        role: "toolResult",
        toolCallId: "tool_spawn",
        toolName: "sessions_spawn",
        isError: false,
      },
    ] as unknown as EmbeddedRunAttemptResult["messagesSnapshot"];
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams) => {
      markUserMessagePersisted(attemptParams);
      return makeAttemptResult({
        assistantTexts: [],
        latestMcpAppChannelView: { viewId: "view-after-tools" },
        toolMetas: [
          { toolName: "write", meta: "path=note.txt" },
          { toolName: "cron" },
          { toolName: "sessions_spawn" },
        ],
        acceptedSessionSpawns,
        successfulCronAdds: 1,
        itemLifecycle: { startedCount: 3, completedCount: 3, activeCount: 0 },
        messagesSnapshot: settledToolResults,
        lastAssistant: toolUseAssistant,
        currentAttemptAssistant: toolUseAssistant,
        codeModeEngaged: true,
        assistantTurns: 1,
        bridgeCalls: { search: 1, describe: 2, call: 3 },
      });
    });
    const finalAssistant = makeLastAssistant({
      content: [{ type: "text", text: "Write completed. Here is the final answer." }],
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Write completed. Here is the final answer."],
        lastAssistant: finalAssistant,
        currentAttemptAssistant: finalAssistant,
        currentAttemptCompletedAssistant: finalAssistant,
      }),
    );
    mockedBuildEmbeddedRunPayloads
      .mockReturnValueOnce([])
      .mockReturnValueOnce([{ text: "Write completed. Here is the final answer." }]);

    const result = await runEmbeddedAgent(makeRunParams("run-tool-use-terminal-continuation"));

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]?.text).toBe("Write completed. Here is the final answer.");
    expect(result.latestMcpAppChannelView).toEqual({ viewId: "view-after-tools" });
    expect(result.successfulCronAdds).toBe(1);
    expect(result.acceptedSessionSpawns).toEqual(acceptedSessionSpawns);
    expect(result.meta.toolSummary).toEqual({
      calls: 3,
      tools: ["write", "cron", "sessions_spawn"],
      failures: 0,
    });
    expect(result.meta.agentMeta).toMatchObject({
      codeModeEngaged: true,
      assistantTurns: 2,
      bridgeCalls: { search: 1, describe: 2, call: 3 },
    });
    const secondCall = runAttemptCall(1);
    expect(secondCall.prompt).toBe(SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION);
    expect(secondCall.disableTools).toBe(true);
    expect(secondCall.operation).toBe("settled-tool-finalization");
    expect(secondCall.suppressNextUserMessagePersistence).toBe(false);
    expect(secondCall.skipPreparedUserTurnMessage).toBe(true);
    expectWarnMessageWith("settled post-tool turn lacked a final answer");
  });

  it.each([
    { label: "interactive user", trigger: "user" as const },
    {
      label: "required isolated cron",
      trigger: "cron" as const,
      terminalReplyExpectation: "required" as const,
    },
  ])("finalizes a settled failed tool once for a $label turn (#118274)", async (runPolicy) => {
    const toolUseAssistant = makeLastAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tool_1", name: "exec", arguments: {} }],
    });
    const failureText = "The exec tool failed: post-processing error.";
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams) => {
      markUserMessagePersisted(attemptParams);
      return makeAttemptResult({
        assistantTexts: [],
        toolMetas: [
          { toolName: "read", isError: true, replaySafe: true },
          { toolName: "exec", isError: true, replaySafe: false },
        ],
        itemLifecycle: { startedCount: 3, completedCount: 3, activeCount: 0 },
        messagesSnapshot: [
          toolUseAssistant,
          {
            role: "toolResult",
            toolCallId: "tool_1",
            toolName: "exec",
            isError: true,
            content: [{ type: "text", text: "post-processing error" }],
          },
          {
            role: "assistant",
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "tool_search_code:tool_1:read:1",
                name: "read",
                arguments: {},
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "tool_search_code:tool_1:read:1",
            toolName: "read",
            isError: true,
            content: [{ type: "text", text: "post-processing error" }],
          },
        ] as unknown as EmbeddedRunAttemptResult["messagesSnapshot"],
        lastAssistant: toolUseAssistant,
        currentAttemptAssistant: toolUseAssistant,
        lastToolError: {
          toolName: "exec",
          error: "post-processing error",
          errorCode: "SYSTEM_RUN_DENIED",
        },
      });
    });
    const finalAssistant = makeLastAssistant({
      content: [{ type: "text", text: failureText }],
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [failureText],
        lastAssistant: finalAssistant,
        currentAttemptAssistant: finalAssistant,
        currentAttemptCompletedAssistant: finalAssistant,
      }),
    );
    mockedBuildEmbeddedRunPayloads
      .mockReturnValueOnce([{ text: "⚠️ 🛠️ Exec failed", isError: true }])
      .mockReturnValueOnce([{ text: failureText }]);

    const result = await runEmbeddedAgent(
      makeRunParams(`run-settled-failed-tool-${runPolicy.trigger}`, runPolicy),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]?.text).toBe(failureText);
    const finalizationCall = runAttemptCall(1);
    expect(finalizationCall.operation).toBe("settled-tool-finalization");
    expect(finalizationCall.disableTools).toBe(true);
    expect(finalizationCall.prompt).toContain(SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION);
    expect(finalizationCall.prompt).toContain(
      "If any tool failed, state that failure plainly and do not claim it succeeded.",
    );
    expect(result.meta.failureSignal).toEqual(
      runPolicy.trigger === "cron"
        ? {
            kind: "execution_denied",
            source: "tool",
            toolName: "exec",
            code: "SYSTEM_RUN_DENIED",
            message: "post-processing error",
            fatalForCron: true,
          }
        : undefined,
    );
  });

  it("preserves a structured visible failed-tool payload without finalizing (#118274)", async () => {
    const toolUseAssistant = makeLastAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tool_1", name: "exec", arguments: {} }],
    });
    const visibleError = {
      text: "Review the failed operation.",
      isError: true,
      channelData: { structuredError: true },
    };
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "exec", isError: true }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        messagesSnapshot: [
          toolUseAssistant,
          { role: "toolResult", toolCallId: "tool_1", toolName: "exec", isError: true },
        ] as unknown as EmbeddedRunAttemptResult["messagesSnapshot"],
        lastAssistant: toolUseAssistant,
        currentAttemptAssistant: toolUseAssistant,
        lastToolError: { toolName: "exec", error: "post-processing error" },
      }),
    );
    mockedBuildEmbeddedRunPayloads.mockReturnValueOnce([visibleError]);

    const result = await runEmbeddedAgent(makeRunParams("run-structured-failed-tool-payload"));

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
    expect(result.payloads?.[0]).toMatchObject(visibleError);
    expectNoWarnMessageWith("settled post-tool turn lacked a final answer");
  });

  it("keeps the original failed-tool warning if finalization completes empty (#118274)", async () => {
    const toolUseAssistant = makeLastAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tool_1", name: "exec", arguments: {} }],
    });
    const warning = { text: "⚠️ 🛠️ Exec failed", isError: true };
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: [],
          toolMetas: [{ toolName: "exec", isError: true }],
          itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
          messagesSnapshot: [
            toolUseAssistant,
            { role: "toolResult", toolCallId: "tool_1", toolName: "exec", isError: true },
          ] as unknown as EmbeddedRunAttemptResult["messagesSnapshot"],
          lastAssistant: toolUseAssistant,
          currentAttemptAssistant: toolUseAssistant,
          lastToolError: { toolName: "exec", error: "post-processing error" },
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: [],
          lastAssistant: makeLastAssistant(),
          currentAttemptAssistant: makeLastAssistant(),
          currentAttemptCompletedAssistant: makeLastAssistant(),
        }),
      );
    mockedBuildEmbeddedRunPayloads.mockReturnValue([warning]);

    const result = await runEmbeddedAgent(makeRunParams("run-failed-tool-finalization-fallback"));

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]).toEqual(warning);
    expectWarnMessageWith("settled-turn finalization completed without a visible answer");
  });

  it("preserves the incomplete-turn failure when the selected harness cannot finalize safely", async () => {
    registerAgentHarness({
      id: "legacy",
      label: "Legacy harness without settled-turn finalization",
      supports: () => ({ supported: true, priority: 100 }),
      runAttempt: async (params) => await mockedRunEmbeddedAttempt(params),
    });
    try {
      const toolUseAssistant = makeLastAssistant({
        stopReason: "toolUse",
        content: [
          { type: "toolCall", id: "tool_1", name: "write", arguments: { path: "note.txt" } },
        ],
      });
      mockedClassifyFailoverReason.mockReturnValue(null);
      mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams) => {
        markUserMessagePersisted(attemptParams);
        return makeAttemptResult({
          assistantTexts: [],
          toolMetas: [{ toolName: "write", meta: "path=note.txt" }],
          itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
          messagesSnapshot: [
            toolUseAssistant,
            { role: "toolResult", toolCallId: "tool_1", toolName: "write", isError: false },
          ] as unknown as EmbeddedRunAttemptResult["messagesSnapshot"],
          lastAssistant: toolUseAssistant,
          currentAttemptAssistant: toolUseAssistant,
        });
      });

      const result = await runEmbeddedAgent(
        makeRunParams("run-tool-use-no-finalization-capability", { agentHarnessId: "legacy" }),
      );

      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
      expect(result.payloads?.[0]).toMatchObject({ isError: true });
      expect(result.payloads?.[0]?.text).toContain(
        "some tool actions may have already been executed",
      );
      expectNoWarnMessageWith("settled post-tool turn lacked a final answer");
    } finally {
      resetRunIncompleteTurnOwnerMocks();
    }
  });

  it("continues from settled side-effecting tools after an empty stop without replaying them", async () => {
    const emptyStopAssistant = makeLastAssistant();
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams) => {
      markUserMessagePersisted(attemptParams);
      return makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "write", meta: "path=note.txt" }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["Writing note.txt…"],
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "telegram",
            to: "chat:123",
            text: "Writing note.txt…",
            sourceReplyFinal: false,
          },
        ],
        lastAssistant: emptyStopAssistant,
        currentAttemptAssistant: emptyStopAssistant,
      });
    });
    const finalAssistant = makeLastAssistant({
      content: [{ type: "text", text: "Write completed. Here is the final answer." }],
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Write completed. Here is the final answer."],
        lastAssistant: finalAssistant,
        currentAttemptAssistant: finalAssistant,
        currentAttemptCompletedAssistant: finalAssistant,
      }),
    );
    mockedBuildEmbeddedRunPayloads
      .mockReturnValueOnce([])
      .mockReturnValueOnce([{ text: "Write completed. Here is the final answer." }]);

    const result = await runEmbeddedAgent(
      makeRunParams("run-empty-stop-settled-tool-continuation", {
        trigger: "cron",
        terminalReplyExpectation: "required",
      }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]?.text).toBe("Write completed. Here is the final answer.");
    expect(runAttemptCall(1).prompt).toBe(SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION);
    expect(runAttemptCall(1).disableTools).toBe(true);
    expectNoWarnMessageWith("empty response detected");
    expectWarnMessageWith("settled post-tool turn lacked a final answer");
  });

  it.each([
    {
      label: "explicit optional expectation",
      trigger: "user" as const,
      terminalReplyExpectation: "optional" as const,
    },
    {
      label: "heartbeat default",
      trigger: "heartbeat" as const,
      terminalReplyExpectation: undefined,
    },
  ])("does not continue settled tools for $label", async (runPolicy) => {
    const emptyStopAssistant = makeLastAssistant();
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams) => {
      markUserMessagePersisted(attemptParams);
      return makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "write", meta: "path=note.txt" }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        lastAssistant: emptyStopAssistant,
        currentAttemptAssistant: emptyStopAssistant,
      });
    });
    mockedBuildEmbeddedRunPayloads.mockReturnValue([]);

    const result = await runEmbeddedAgent(
      makeRunParams("run-optional-empty-stop-settled-tool", {
        trigger: runPolicy.trigger,
        terminalReplyExpectation: runPolicy.terminalReplyExpectation,
      }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads?.[0]).toMatchObject({ isError: true });
    expectNoWarnMessageWith("settled post-tool turn lacked a final answer");
  });

  it("records silent success when the settled-tool finalization completes empty", async () => {
    const emptyStopAssistant = makeLastAssistant();
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams) => {
      markUserMessagePersisted(attemptParams);
      return makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "write", meta: "path=note.txt" }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        lastAssistant: emptyStopAssistant,
        currentAttemptAssistant: emptyStopAssistant,
      });
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: emptyStopAssistant,
        currentAttemptAssistant: emptyStopAssistant,
      }),
    );
    mockedBuildEmbeddedRunPayloads.mockReturnValue([]);

    const result = await runEmbeddedAgent(
      makeRunParams("run-empty-stop-settled-tool-continuation-exhausted", {
        allowEmptyAssistantReplyAsSilent: true,
      }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads).toBeUndefined();
    expect(result.meta.error).toBeUndefined();
    expect(result.meta.terminalReplyKind).toBeUndefined();
    expect(result.meta.finalAssistantVisibleText).toBeUndefined();
    expect(result.meta.finalAssistantRawText).toBeUndefined();
    expect(result.meta.stopReason).toBe("stop");
    expectNoWarnMessageWith("empty response detected");
    expectWarnMessageWith("settled-turn finalization completed without a visible answer");
  });

  it.each([
    {
      label: "provider failure",
      finalAttempt: {
        assistantTexts: [],
        promptError: new Error("finalizer provider failure"),
        promptErrorSource: "prompt" as const,
      },
    },
    {
      label: "preflight recovery request",
      finalAttempt: {
        assistantTexts: [],
        preflightRecovery: { route: "compact_only" as const, handled: true as const },
      },
    },
    {
      label: "compaction continuation request",
      finalAttempt: { assistantTexts: [], compactionCount: 1 },
    },
    {
      label: "before-finalize revision request",
      finalAttempt: {
        assistantTexts: [],
        beforeAgentFinalizeRevisionReason: "revise this answer",
      },
    },
  ])("does not escape finalization through a $label", async ({ finalAttempt }) => {
    const toolUseAssistant = makeLastAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tool_1", name: "write", arguments: {} }],
    });
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: [],
          toolMetas: [{ toolName: "write" }],
          itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
          messagesSnapshot: [
            toolUseAssistant,
            { role: "toolResult", toolCallId: "tool_1", toolName: "write", isError: false },
          ] as unknown as EmbeddedRunAttemptResult["messagesSnapshot"],
          lastAssistant: toolUseAssistant,
          currentAttemptAssistant: toolUseAssistant,
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult(finalAttempt));
    mockedBuildEmbeddedRunPayloads.mockReturnValue([]);

    const result = await runEmbeddedAgent(makeRunParams("run-settled-finalizer-sticky-operation"));

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]).toMatchObject({ isError: true });
    expect(result.payloads?.[0]?.text).toContain(
      "some tool actions may have already been executed",
    );
  });

  it("surfaces the existing incomplete-turn error after one tool-use continuation", async () => {
    const toolUseAssistant = makeLastAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tool_1", name: "write", arguments: { path: "note.txt" } }],
    });
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "write", meta: "path=note.txt" }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        messagesSnapshot: [
          toolUseAssistant,
          { role: "toolResult", toolCallId: "tool_1", toolName: "write", isError: false },
        ] as unknown as EmbeddedRunAttemptResult["messagesSnapshot"],
        lastAssistant: toolUseAssistant,
        currentAttemptAssistant: toolUseAssistant,
      }),
    );

    const result = await runEmbeddedAgent(
      makeRunParams("run-tool-use-terminal-continuation-exhausted"),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain(
      "some tool actions may have already been executed",
    );
    expectWarnMessageWith("settled-turn finalization failed closed");
  });

  it("does not claim completion for a toolUse terminal whose tools never started", async () => {
    const toolUseAssistant = makeLastAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tool_1", name: "write", arguments: { path: "note.txt" } }],
    });
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: [],
        toolMetas: [],
        itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
        lastAssistant: toolUseAssistant,
        currentAttemptAssistant: toolUseAssistant,
      }),
    );

    await runEmbeddedAgent(makeRunParams("run-tool-use-terminal-never-started"));

    for (let call = 0; call < mockedRunEmbeddedAttempt.mock.calls.length; call += 1) {
      expect(runAttemptCall(call).prompt).not.toContain(
        SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION,
      );
    }
    expectNoWarnMessageWith("settled post-tool turn lacked a final answer");
  });

  it("ignores stale prior-turn tool results with colliding ids", async () => {
    const toolUseAssistant = makeLastAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tool_1", name: "write", arguments: { path: "note.txt" } }],
    });
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: [],
        toolMetas: [],
        itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
        // A completed result from a PRIOR turn reusing the same id sits before
        // the terminal assistant; it must not prove the new batch dispatched.
        messagesSnapshot: [
          { role: "toolResult", toolCallId: "tool_1", toolName: "write", isError: false },
          toolUseAssistant,
        ] as unknown as EmbeddedRunAttemptResult["messagesSnapshot"],
        lastAssistant: toolUseAssistant,
        currentAttemptAssistant: toolUseAssistant,
      }),
    );

    await runEmbeddedAgent(makeRunParams("run-tool-use-terminal-stale-prior-result"));

    for (let call = 0; call < mockedRunEmbeddedAttempt.mock.calls.length; call += 1) {
      expect(runAttemptCall(call).prompt).not.toContain(
        SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION,
      );
    }
    expectNoWarnMessageWith("settled post-tool turn lacked a final answer");
  });

  it("does not claim completion when only part of a multi-tool request dispatched", async () => {
    const toolUseAssistant = makeLastAssistant({
      stopReason: "toolUse",
      content: [
        { type: "toolCall", id: "tool_1", name: "write", arguments: { path: "a.txt" } },
        { type: "toolCall", id: "tool_2", name: "write", arguments: { path: "b.txt" } },
      ],
    });
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "write", meta: "path=a.txt" }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        messagesSnapshot: [
          toolUseAssistant,
          { role: "toolResult", toolCallId: "tool_1", toolName: "write", isError: false },
        ] as unknown as EmbeddedRunAttemptResult["messagesSnapshot"],
        lastAssistant: toolUseAssistant,
        currentAttemptAssistant: toolUseAssistant,
      }),
    );

    await runEmbeddedAgent(makeRunParams("run-tool-use-terminal-partial-dispatch"));

    for (let call = 0; call < mockedRunEmbeddedAttempt.mock.calls.length; call += 1) {
      expect(runAttemptCall(call).prompt).not.toContain(
        SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION,
      );
    }
    expectNoWarnMessageWith("settled post-tool turn lacked a final answer");
  });

  it("retries reasoning-only assistant turns even when deliberate silence is allowed", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: makeLastAssistant({
          stopReason: "end_turn",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_silent_group", type: "reasoning" }),
            },
          ],
        }),
      }),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Visible answer."],
        lastAssistant: makeLastAssistant({
          stopReason: "end_turn",
          content: [{ type: "text", text: "Visible answer." }],
        }),
      }),
    );

    await runEmbeddedAgent(
      makeRunParams("run-reasoning-only-silent", { allowEmptyAssistantReplyAsSilent: true }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(runAttemptCall(1).prompt).toBe(REASONING_ONLY_RETRY_INSTRUCTION);
    expectWarnMessageWith("reasoning-only assistant turn detected");
  });

  it("replays an unpersisted reasoning continuation across a missing-assistant retry", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams) => {
      markUserMessagePersisted(attemptParams);
      return makeAttemptResult({
        assistantTexts: [],
        lastAssistant: makeLastAssistant({
          stopReason: "end_turn",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_retry_boundary", type: "reasoning" }),
            },
          ],
        }),
      });
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: undefined,
        currentAttemptAssistant: undefined,
      }),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({ assistantTexts: ["Visible answer."] }),
    );

    await runEmbeddedAgent(
      makeRunParams("run-reasoning-continuation-missing-assistant", { model: "gpt-5.4" }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(runAttemptCall(1)).toMatchObject({
      prompt: REASONING_ONLY_RETRY_INSTRUCTION,
      skipPreparedUserTurnMessage: true,
      suppressNextUserMessagePersistence: false,
    });
    expect(runAttemptCall(2)).toMatchObject({
      prompt: REASONING_ONLY_RETRY_INSTRUCTION,
      skipPreparedUserTurnMessage: true,
      suppressNextUserMessagePersistence: false,
    });
  });

  it("does not retry or warn on reasoning-only turns when a messaging tool already delivered", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["Delivered through the message tool."],
        lastAssistant: makeLastAssistant({
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_after_send", type: "reasoning" }),
            },
          ],
        }),
      }),
    );

    const result = await runEmbeddedAgent(
      makeRunParams("run-reasoning-only-after-side-effects", { model: "gpt-5.4" }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toBeUndefined();
  });

  it("retries reasoning-only turns when the assistant ended in error", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    const errorAssistant = makeLastAssistant({
      stopReason: "error",
      model: "gpt-5.4",
      errorMessage: "provider failed after emitting reasoning",
      content: [
        {
          type: "thinking",
          thinking: "internal reasoning",
          thinkingSignature: JSON.stringify({ id: "rs_error_turn", type: "reasoning" }),
        },
      ],
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: errorAssistant,
        currentAttemptAssistant: errorAssistant,
      }),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Recovered."],
        lastAssistant: makeLastAssistant({
          model: "gpt-5.4",
          content: [{ type: "text", text: "Recovered." }],
        }),
      }),
    );

    const result = await runEmbeddedAgent(
      makeRunParams("run-reasoning-only-assistant-error", { model: "gpt-5.4" }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads).toBeUndefined();
  });

  it("does not retry reasoning-only turns for non-strict-agentic providers", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: makeLastAssistant({
          stopReason: "end_turn",
          provider: "anthropic",
          model: "sonnet-4.6",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({
                id: "rs_provider_mismatch",
                type: "reasoning",
              }),
            },
          ],
        }),
      }),
    );

    const result = await runEmbeddedAgent(
      makeRunParams("run-reasoning-only-provider-mismatch", {
        provider: "anthropic",
        model: "sonnet-4.6",
      }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("Please try again");
  });

  it("retries Kimi Anthropic reasoning-only turns with a visible-answer continuation instruction", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedResolveModelAsync.mockResolvedValue({
      model: {
        id: "kimi-for-coding",
        provider: "kimi",
        contextWindow: 262144,
        api: "anthropic-messages",
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
        lastAssistant: makeLastAssistant({
          api: "anthropic-messages",
          provider: "kimi",
          model: "kimi-for-coding",
          content: [
            {
              type: "thinking",
              thinking: "internal Kimi reasoning",
              thinkingSignature: "",
            },
          ],
        }),
      }),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Visible Kimi answer."],
        lastAssistant: makeLastAssistant({
          api: "anthropic-messages",
          provider: "kimi",
          model: "kimi-for-coding",
          content: [{ type: "text", text: "Visible Kimi answer." }],
        }),
      }),
    );

    await runEmbeddedAgent(
      makeRunParams("run-kimi-anthropic-reasoning-only-continuation", {
        provider: "kimi",
        model: "kimi-for-coding",
      }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    const secondCall = runAttemptCall(1);
    expect(secondCall.prompt).toContain(REASONING_ONLY_RETRY_INSTRUCTION);
    expectWarnMessageWith("reasoning-only assistant turn detected");
  });

  it("retries generic empty GPT turns with a visible-answer continuation instruction", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams) => {
      markUserMessagePersisted(attemptParams);
      return makeAttemptResult({
        assistantTexts: [],
        lastAssistant: makeLastAssistant({
          stopReason: "end_turn",
          model: "gpt-5.4",
          content: [{ type: "text", text: "" }],
        }),
      });
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Visible answer."],
        lastAssistant: makeLastAssistant({
          stopReason: "end_turn",
          model: "gpt-5.4",
          content: [{ type: "text", text: "Visible answer." }],
        }),
      }),
    );

    await runEmbeddedAgent(makeRunParams("run-empty-response-continuation", { model: "gpt-5.4" }));

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    const secondCall = runAttemptCall(1);
    expect(secondCall.prompt).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    expect(secondCall.suppressNextUserMessagePersistence).toBe(false);
    expect(secondCall.skipPreparedUserTurnMessage).toBe(true);
    expectWarnMessageWith("empty response detected");
  });

  it("retries replay-safe missing turns despite a stale aborted transcript assistant", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    const staleAssistant = makeLastAssistant({
      stopReason: "aborted",
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: staleAssistant,
        currentAttemptAssistant: undefined,
      }),
    );
    const recoveredAssistant = makeLastAssistant({
      stopReason: "end_turn",
      content: [{ type: "text", text: "Recovered answer." }],
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Recovered answer."],
        lastAssistant: recoveredAssistant,
        currentAttemptAssistant: recoveredAssistant,
      }),
    );

    const result = await runEmbeddedAgent(makeRunParams("run-missing-assistant-retry"));

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(runAttemptCall(1).prompt).toContain(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    expect(result.meta?.finalAssistantVisibleText).toBe("Recovered answer.");
    expectWarnMessageWith("empty response detected");
    expectNoWarnMessageWith("missing assistant terminal message detected");
    expectNoWarnMessageWith("incomplete turn detected");
  });

  it("retries missing terminal assistant turns with the same prompt without re-persisting the user message", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams) => {
      markUserMessagePersisted(attemptParams);
      return makeAttemptResult({
        assistantTexts: [],
        lastAssistant: undefined,
        currentAttemptAssistant: undefined,
      });
    });
    const recoveredAssistant = makeLastAssistant({
      stopReason: "end_turn",
      content: [{ type: "text", text: "Recovered answer." }],
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Recovered answer."],
        lastAssistant: recoveredAssistant,
        currentAttemptAssistant: recoveredAssistant,
      }),
    );

    const result = await runEmbeddedAgent(makeRunParams("run-missing-assistant-same-prompt-retry"));

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    // The same-prompt replay must not append the inbound user message a second time.
    expect(runAttemptCall(1).prompt).toBe(runAttemptCall(0).prompt);
    expect(runAttemptCall(1).suppressNextUserMessagePersistence).toBe(true);
    expect(result.meta?.finalAssistantVisibleText).toBe("Recovered answer.");
    expectWarnMessageWith("missing assistant terminal message detected");
    expectNoWarnMessageWith("empty response detected");
    expectNoWarnMessageWith("incomplete turn detected");
  });

  it("waits for asynchronous user persistence before retrying a missing terminal turn", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    const persistedMessage = { role: "user" as const, content: "test prompt", timestamp: 1 };
    const admission = {
      agentId: "main",
      sessionId: overflowBaseRunParams.sessionId,
      sessionKey: overflowBaseRunParams.sessionKey,
      storePath: "/tmp/openclaw-transcript.jsonl",
      generation: "generation-1",
      entryId: "msg-user-delayed",
      rawSeq: 1,
      effectiveParentId: null,
      activeMessagePosition: 0,
      logicalTurnId: "run-missing-assistant-delayed-persistence",
      role: "user" as const,
    };
    let resolvePersistApproved:
      | ((result: {
          admission: typeof admission;
          sessionFile: string;
          sessionEntry: undefined;
          messageId: string;
          message: typeof persistedMessage;
        }) => void)
      | undefined;
    let pendingPersistence: Promise<void> | undefined;
    const persistApproved = vi.fn(
      () =>
        new Promise<{
          admission: typeof admission;
          sessionFile: string;
          sessionEntry: undefined;
          messageId: string;
          message: typeof persistedMessage;
        }>((resolve) => {
          resolvePersistApproved = resolve;
        }),
    );
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams) => {
      markUserMessagePersisted(attemptParams);
      return makeAttemptResult({
        assistantTexts: [],
        lastAssistant: undefined,
        currentAttemptAssistant: undefined,
      });
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({ assistantTexts: ["Recovered answer."] }),
    );

    const runPromise = runEmbeddedAgent(
      makeRunParams("run-missing-assistant-delayed-persistence", {
        userTurnTranscriptRecorder: {
          message: persistedMessage,
          resolveMessage: vi.fn(async () => persistedMessage),
          getAdmissionReceipt: () => admission,
          markRuntimePersistencePending: vi.fn((pending) => {
            pendingPersistence = pending;
          }),
          markRuntimePersisted: vi.fn(),
          markBlocked: vi.fn(),
          hasPersisted: vi.fn(() => false),
          isBlocked: vi.fn(() => false),
          hasRuntimePersistencePending: vi.fn(() => pendingPersistence !== undefined),
          waitForRuntimePersistence: vi.fn(async () => {
            await pendingPersistence;
          }),
          persistApproved,
          persistBlocked: vi.fn(async () => undefined),
          persistFallback: vi.fn(async () => undefined),
        },
      }),
    );

    await vi.waitFor(() => {
      expect(persistApproved).toHaveBeenCalledOnce();
    });
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);

    resolvePersistApproved?.({
      admission,
      sessionFile: "/tmp/openclaw-transcript.jsonl",
      sessionEntry: undefined,
      messageId: "msg-user-delayed",
      message: persistedMessage,
    });
    await runPromise;

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(runAttemptCall(1).suppressNextUserMessagePersistence).toBe(true);
  });

  it("persists a missing-turn retry when the first attempt never persisted the user message", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: undefined,
        currentAttemptAssistant: undefined,
      }),
    );
    const recoveredAssistant = makeLastAssistant({
      stopReason: "end_turn",
      content: [{ type: "text", text: "Recovered answer." }],
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Recovered answer."],
        lastAssistant: recoveredAssistant,
        currentAttemptAssistant: recoveredAssistant,
      }),
    );

    await runEmbeddedAgent(makeRunParams("run-missing-assistant-unpersisted-retry"));

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(runAttemptCall(1).suppressNextUserMessagePersistence).toBe(false);
  });

  it("retries zero-token empty Claude stop turns with a visible-answer continuation instruction", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: makeLastAssistant({
          provider: "anthropic",
          model: "claude-opus-4.7",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
          },
        }),
      }),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Visible Claude answer."],
        lastAssistant: makeLastAssistant({
          provider: "anthropic",
          model: "claude-opus-4.7",
          content: [{ type: "text", text: "Visible Claude answer." }],
          usage: {
            input: 100,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 105,
          },
        }),
      }),
    );

    await runEmbeddedAgent(
      makeRunParams("run-empty-zero-usage-claude-continuation", {
        provider: "anthropic",
        model: "claude-opus-4.7",
      }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    const secondCall = runAttemptCall(1);
    expect(secondCall.prompt).toContain(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    expectWarnMessageWith("empty response detected");
  });

  it("retries empty openai-compatible stop turns even when the backend reports output tokens", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedResolveModelAsync.mockResolvedValue({
      model: {
        id: "qwen3.6-27b",
        provider: "llamacpp",
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
        lastAssistant: makeLastAssistant({
          api: "openai-completions",
          provider: "llamacpp",
          model: "qwen3.6-27b",
          usage: {
            input: 512,
            output: 103,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 615,
          },
        }),
      }),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Visible local answer."],
        lastAssistant: makeLastAssistant({
          api: "openai-completions",
          provider: "llamacpp",
          model: "qwen3.6-27b",
          content: [{ type: "text", text: "Visible local answer." }],
          usage: {
            input: 640,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 645,
          },
        }),
      }),
    );

    await runEmbeddedAgent(
      makeRunParams("run-empty-openai-compatible-stop-continuation", {
        provider: "llamacpp",
        model: "qwen3.6-27b",
      }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    const secondCall = runAttemptCall(1);
    expect(secondCall.prompt).toContain(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    expectWarnMessageWith("empty response detected");
  });

  it("retries empty Anthropic-compatible stop turns even when the provider is not Kimi", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedResolveModelAsync.mockResolvedValue({
      model: {
        id: "claude-opus-4-7",
        provider: "sub2api",
        contextWindow: 200000,
        api: "anthropic-messages",
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
        lastAssistant: makeLastAssistant({
          api: "anthropic-messages",
          provider: "sub2api",
          model: "claude-opus-4-7",
          usage: {
            input: 2048,
            output: 3100,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 5148,
          },
        }),
      }),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Visible Anthropic-compatible answer."],
        lastAssistant: makeLastAssistant({
          api: "anthropic-messages",
          provider: "sub2api",
          model: "claude-opus-4-7",
          content: [{ type: "text", text: "Visible Anthropic-compatible answer." }],
          usage: {
            input: 2300,
            output: 8,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2308,
          },
        }),
      }),
    );

    await runEmbeddedAgent(
      makeRunParams("run-empty-anthropic-compatible-stop-continuation", {
        provider: "sub2api",
        model: "claude-opus-4-7",
      }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    const secondCall = runAttemptCall(1);
    expect(secondCall.prompt).toContain(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    expectWarnMessageWith("empty response detected");
  });

  it("surfaces an error after exhausting empty-response retries", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
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
      makeRunParams("run-empty-response-exhausted", { model: "gpt-5.4" }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("Please try again");
    expectWarnMessageWith("empty response retries exhausted");
  });

  it("surfaces an error after exhausting reasoning-only retries without a visible answer", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: makeLastAssistant({
          stopReason: "end_turn",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({
                id: "rs_reasoning_exhausted",
                type: "reasoning",
              }),
            },
          ],
        }),
      }),
    );

    const result = await runEmbeddedAgent(
      makeRunParams("run-reasoning-only-exhausted", {
        model: "gpt-5.4",
        reasoningLevel: "on",
      }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("Please try again");
    expectWarnMessageWith("reasoning-only retries exhausted");
  });

  it("preserves a terminal tool presentation after reasoning-only retries are exhausted", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    const reasoningOnlyAttempt = async () =>
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: makeLastAssistant({
          stopReason: "end_turn",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({
                id: "rs_reasoning_terminal_presentation",
                type: "reasoning",
              }),
            },
          ],
        }),
      });
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
      return reasoningOnlyAttempt();
    });
    mockedRunEmbeddedAttempt.mockImplementation(reasoningOnlyAttempt);

    const result = await runEmbeddedAgent(
      makeRunParams("run-reasoning-terminal-presentation", {
        model: "gpt-5.4",
        reasoningLevel: "on",
      }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(result.payloads).toEqual([
      {
        text:
          "Web fetch completed.\nOrigin: https://example.com\nStatus: 200\n\n" +
          "⚠️ Agent couldn't generate a response. Please try again.",
        isError: true,
      },
    ]);
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

  it("flags tool-use stop reason as incomplete even when pre-tool text exists (#76477)", () => {
    expect(
      isIncompleteTerminalAssistantTurn({
        hasAssistantVisibleText: true,
        lastAssistant: { stopReason: "toolUse" },
      }),
    ).toBe(true);
    expect(
      isIncompleteTerminalAssistantTurn({
        hasAssistantVisibleText: false,
        lastAssistant: { stopReason: "toolUse" },
      }),
    ).toBe(true);
    expect(
      isIncompleteTerminalAssistantTurn({
        hasAssistantVisibleText: true,
        lastAssistant: { stopReason: "end_turn" },
      }),
    ).toBe(false);
    expect(
      isIncompleteTerminalAssistantTurn({
        hasAssistantVisibleText: true,
        lastAssistant: { stopReason: "length" },
      }),
    ).toBe(true);
    expect(
      isIncompleteTerminalAssistantTurn({
        hasAssistantVisibleText: true,
        hasTerminalOutput: true,
        lastAssistant: { stopReason: "length" },
      }),
    ).toBe(false);
    expect(
      isIncompleteTerminalAssistantTurn({
        hasAssistantVisibleText: true,
        hasTerminalOutput: true,
        lastAssistant: { stopReason: "toolUse" },
      }),
    ).toBe(true);
  });

  it.each([
    { label: "aborted", aborted: true, timedOut: false, promptError: null },
    { label: "timed out", aborted: false, timedOut: true, promptError: null },
    { label: "prompt error", aborted: false, timedOut: false, promptError: new Error("closed") },
  ])("does not continue a $label tool-use terminal turn", ({ aborted, timedOut, promptError }) => {
    const toolUseAssistant = makeLastAssistant({
      stopReason: "toolUse",
      content: [{ type: "tool_use", id: "tool_1", name: "bash", input: {} }],
    });
    const instruction = resolveSettledToolTerminalContinuationInstruction(
      makeSettledContinuationParams(
        {
          assistantTexts: [],
          toolMetas: [{ toolName: "bash" }],
          itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
          lastAssistant: toolUseAssistant,
          currentAttemptAssistant: toolUseAssistant,
        },
        { aborted, timedOut, promptError },
      ),
    );

    expect(instruction).toBeNull();
  });

  it.each([
    {
      label: "a matching failure summary",
      lastToolError: { toolName: "exec", error: "post-processing error" },
    },
    { label: "no remaining failure summary", lastToolError: undefined },
  ])(
    "recognizes successful and failed current-batch tools with $label (#118274)",
    ({ lastToolError }) => {
      const toolUseAssistant = makeLastAssistant({
        stopReason: "toolUse",
        content: [
          { type: "toolCall", id: "tool_ok", name: "read", arguments: {} },
          { type: "toolCall", id: "tool_failed", name: "exec", arguments: {} },
        ],
      });
      const instruction = resolveSettledToolTerminalContinuationInstruction(
        makeSettledContinuationParams({
          assistantTexts: [],
          toolMetas: [{ toolName: "read" }, { toolName: "exec", isError: true }],
          itemLifecycle: { startedCount: 2, completedCount: 2, activeCount: 0 },
          messagesSnapshot: [
            toolUseAssistant,
            { role: "toolResult", toolCallId: "tool_ok", toolName: "read", isError: false },
            { role: "toolResult", toolCallId: "tool_failed", toolName: "exec", isError: true },
          ] as unknown as EmbeddedRunAttemptResult["messagesSnapshot"],
          lastAssistant: toolUseAssistant,
          currentAttemptAssistant: toolUseAssistant,
          lastToolError,
        }),
      );

      expect(instruction).toContain(SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION);
      expect(instruction).toContain(
        "If any tool failed, state that failure plainly and do not claim it succeeded.",
      );
    },
  );

  it.each([
    { label: "progress", sourceReplyFinal: false, expectedFinalization: true },
    { label: "final reply", sourceReplyFinal: true, expectedFinalization: false },
    { label: "legacy unmarked send", sourceReplyFinal: undefined, expectedFinalization: false },
  ])(
    "handles $label delivery evidence before settled finalization",
    ({ sourceReplyFinal, expectedFinalization }) => {
      const emptyStopAssistant = makeLastAssistant();
      const instruction = resolveSettledToolTerminalContinuationInstruction(
        makeSettledContinuationParams(
          {
            assistantTexts: [],
            toolMetas: [{ toolName: "write" }],
            itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
            didSendViaMessagingTool: true,
            messagingToolSentTexts: ["Writing note.txt…"],
            messagingToolSentTargets: [
              {
                tool: "message",
                provider: "telegram",
                to: "chat:123",
                text: "Writing note.txt…",
                sourceReplyFinal,
              },
            ],
            lastAssistant: emptyStopAssistant,
            currentAttemptAssistant: emptyStopAssistant,
          },
          { allowEmptyStopContinuation: true },
        ),
      );

      expect(instruction).toBe(
        expectedFinalization ? SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION : null,
      );
    },
  );

  it.each([
    {
      label: "an unrelated current-batch failure summary",
      resultToolName: "exec",
      lastErrorToolName: "read",
    },
    {
      label: "a failed result with the wrong tool identity",
      resultToolName: "read",
      lastErrorToolName: "exec",
    },
  ])("does not finalize $label (#118274)", ({ resultToolName, lastErrorToolName }) => {
    const toolUseAssistant = makeLastAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tool_1", name: "exec", arguments: {} }],
    });
    const instruction = resolveSettledToolTerminalContinuationInstruction(
      makeSettledContinuationParams({
        assistantTexts: [],
        toolMetas: [{ toolName: resultToolName, isError: true }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        messagesSnapshot: [
          toolUseAssistant,
          {
            role: "toolResult",
            toolCallId: "tool_1",
            toolName: resultToolName,
            isError: true,
          },
        ] as unknown as EmbeddedRunAttemptResult["messagesSnapshot"],
        lastAssistant: toolUseAssistant,
        currentAttemptAssistant: toolUseAssistant,
        lastToolError: { toolName: lastErrorToolName, error: "post-processing error" },
      }),
    );

    expect(instruction).toBeNull();
  });

  it("does not settle same-name terminal calls from one failed result (#118274)", () => {
    const toolUseAssistant = makeLastAssistant({
      stopReason: "toolUse",
      content: [
        { type: "toolCall", id: "tool_1", name: "exec", arguments: {} },
        { type: "toolCall", id: "tool_2", name: "exec", arguments: {} },
      ],
    });
    const instruction = resolveSettledToolTerminalContinuationInstruction(
      makeSettledContinuationParams({
        assistantTexts: [],
        toolMetas: [{ toolName: "exec", isError: true }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        messagesSnapshot: [
          toolUseAssistant,
          { role: "toolResult", toolCallId: "tool_1", toolName: "exec", isError: true },
        ] as unknown as EmbeddedRunAttemptResult["messagesSnapshot"],
        lastAssistant: toolUseAssistant,
        currentAttemptAssistant: toolUseAssistant,
        lastToolError: { toolName: "exec", error: "post-processing error" },
      }),
    );

    expect(instruction).toBeNull();
  });

  it.each([
    {
      label: "an async tool is still running",
      attemptOverrides: { toolMetas: [{ toolName: "exec", isError: true, asyncStarted: true }] },
    },
    {
      label: "an accepted child session owns the response",
      attemptOverrides: {
        acceptedSessionSpawns: [
          { runId: "run-child", childSessionKey: "agent:main:subagent:child" },
        ],
      },
    },
    {
      label: "a client tool remains pending",
      attemptOverrides: { clientToolCalls: [{ name: "pending", params: {} }] },
    },
    {
      label: "the turn yielded",
      attemptOverrides: { yieldDetected: true },
    },
    {
      label: "an approval prompt was already delivered",
      attemptOverrides: { didSendDeterministicApprovalPrompt: true },
    },
  ])("does not finalize a failed terminal tool when $label (#118274)", ({ attemptOverrides }) => {
    const toolUseAssistant = makeLastAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tool_1", name: "exec", arguments: {} }],
    });
    const instruction = resolveSettledToolTerminalContinuationInstruction(
      makeSettledContinuationParams({
        assistantTexts: [],
        toolMetas: [{ toolName: "exec", isError: true }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        messagesSnapshot: [
          toolUseAssistant,
          { role: "toolResult", toolCallId: "tool_1", toolName: "exec", isError: true },
        ] as unknown as EmbeddedRunAttemptResult["messagesSnapshot"],
        lastAssistant: toolUseAssistant,
        currentAttemptAssistant: toolUseAssistant,
        lastToolError: { toolName: "exec", error: "post-processing error" },
        ...attemptOverrides,
      }),
    );

    expect(instruction).toBeNull();
  });

  it.each([
    { label: "background trigger", allowEmptyStopContinuation: false },
    {
      label: "active tool",
      allowEmptyStopContinuation: true,
      completedCount: 0,
      activeCount: 1,
    },
    {
      label: "partially completed tool batch",
      allowEmptyStopContinuation: true,
      startedCount: 2,
      completedCount: 1,
    },
    { label: "async tool", allowEmptyStopContinuation: true, asyncStarted: true },
    { label: "failed tool", allowEmptyStopContinuation: true, isError: true },
  ])(
    "does not continue an empty stop after $label activity",
    ({
      allowEmptyStopContinuation,
      startedCount = 1,
      completedCount = 1,
      activeCount = 0,
      asyncStarted,
      isError,
    }) => {
      const emptyStopAssistant = makeLastAssistant();
      const instruction = resolveSettledToolTerminalContinuationInstruction(
        makeSettledContinuationParams(
          {
            assistantTexts: [],
            toolMetas: [{ toolName: "write", asyncStarted, isError }],
            itemLifecycle: { startedCount, completedCount, activeCount },
            lastAssistant: emptyStopAssistant,
            currentAttemptAssistant: emptyStopAssistant,
          },
          { allowEmptyStopContinuation },
        ),
      );

      expect(instruction).toBeNull();
    },
  );

  it("does not use a stale prior-turn empty stop to prove a settled continuation", () => {
    const staleEmptyStopAssistant = makeLastAssistant();
    const instruction = resolveSettledToolTerminalContinuationInstruction(
      makeSettledContinuationParams(
        {
          assistantTexts: [],
          toolMetas: [{ toolName: "write" }],
          itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
          lastAssistant: staleEmptyStopAssistant,
          currentAttemptAssistant: undefined,
        },
        { allowEmptyStopContinuation: true },
      ),
    );

    expect(instruction).toBeNull();
  });

  it("does not flag stale lastAssistant=toolUse when currentAttemptAssistant=stop exists (#80918)", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams(
        {
          assistantTexts: ["Analysis...", "Here is the final answer after update_plan."],
          toolMetas: [{ toolName: "update_plan" }],
          lastAssistant: makeLastAssistant({
            stopReason: "toolUse",
            content: [
              { type: "text", text: "Analysis..." },
              { type: "tool_use", id: "tool_1", name: "update_plan", input: {} },
            ],
          }),
          currentAttemptAssistant: makeLastAssistant({
            content: [{ type: "text", text: "Here is the final answer after update_plan." }],
          }),
        },
        { payloadCount: 1 },
      ),
    );

    expect(incompleteTurnText).toBeNull();
  });

  it("still flags incomplete-turn when currentAttemptAssistant is absent and lastAssistant=toolUse (#76477 regression)", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams(
        {
          assistantTexts: ["Let me update the file..."],
          toolMetas: [{ toolName: "write" }],
          lastAssistant: makeLastAssistant({
            stopReason: "toolUse",
            model: "gpt-5.4",
            content: [
              { type: "text", text: "Let me update the file..." },
              { type: "tool_use", id: "tool_1", name: "write", input: {} },
            ],
          }),
          currentAttemptAssistant: undefined,
        },
        { payloadCount: 1 },
      ),
    );

    expect(incompleteTurnText).toContain("couldn't generate a response");
  });

  it("surfaces no-visible-answer recovery for app-server interrupted tool-only output", () => {
    const interruptedToolOnlyAttempt = makeAttemptResult({
      assistantTexts: [],
      toolMetas: [{ toolName: "bash", meta: "workspace" }],
      messagesSnapshot: [
        {
          role: "user",
          content: "check running processes",
          timestamp: 1,
        },
        {
          role: "toolResult",
          content: "",
          isError: false,
          details: { aggregated: "" },
          timestamp: 2,
        } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
      ],
    });

    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: interruptedToolOnlyAttempt.assistantTexts.length,
      aborted: false,
      timedOut: false,
      attempt: interruptedToolOnlyAttempt,
    });

    expect(incompleteTurnText).toContain("couldn't generate a response");

    const explicitCancellationText = resolveIncompleteTurnPayloadText({
      payloadCount: interruptedToolOnlyAttempt.assistantTexts.length,
      aborted: true,
      externalAbort: true,
      timedOut: false,
      attempt: interruptedToolOnlyAttempt,
    });

    expect(explicitCancellationText).toBeNull();

    const internalAbortText = resolveIncompleteTurnPayloadText({
      payloadCount: interruptedToolOnlyAttempt.assistantTexts.length,
      aborted: true,
      externalAbort: false,
      timedOut: false,
      attempt: interruptedToolOnlyAttempt,
    });

    expect(internalAbortText).toContain("couldn't generate a response");
  });

  it("allows a same-prompt retry only for replay-safe missing assistant turns", () => {
    const replaySafeAttempt = makeAttemptResult({
      assistantTexts: [],
      lastAssistant: undefined,
      currentAttemptAssistant: undefined,
    });

    expect(
      shouldRetryMissingAssistantTurn({
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt: replaySafeAttempt,
      }),
    ).toBe(true);
    expect(
      shouldRetryMissingAssistantTurn({
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt: makeAttemptResult({
          assistantTexts: [],
          lastAssistant: undefined,
          currentAttemptAssistant: undefined,
          toolMetas: [{ toolName: "image_generate", asyncStarted: true }],
        }),
      }),
    ).toBe(false);
    expect(
      shouldRetryMissingAssistantTurn({
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt: makeAttemptResult({
          assistantTexts: [],
          lastAssistant: undefined,
          currentAttemptAssistant: undefined,
          itemLifecycle: {
            startedCount: 1,
            completedCount: 0,
            activeCount: 1,
          },
        }),
      }),
    ).toBe(false);
  });

  it("detects tool-use terminal turn with pre-tool text as incomplete (#76477)", () => {
    // When the last assistant message ended with stopReason=toolUse, pre-tool
    // text alone must not suppress the incomplete-turn guard. The model
    // expected to continue after tool results but the post-tool response was
    // never produced.
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams(
        {
          assistantTexts: ["Initial analysis of the codebase..."],
          toolMetas: [{ toolName: "read", meta: "path=src/index.ts" }],
          lastAssistant: makeLastAssistant({
            stopReason: "toolUse",
            provider: "anthropic",
            model: "sonnet-4.6",
            content: [
              { type: "text", text: "Initial analysis of the codebase..." },
              { type: "tool_use", id: "tool_1", name: "read", input: { path: "src/index.ts" } },
            ],
          }),
        },
        { payloadCount: 1 },
      ),
    );

    expect(incompleteTurnText).toContain("couldn't generate a response");
  });

  it("does not surface incomplete-turn error while an async media task is running", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams({
        assistantTexts: [],
        toolMetas: [
          {
            toolName: "image_generate",
            meta: 'generate prompt="a portrait"',
            asyncStarted: true,
          },
        ],
        lastAssistant: makeLastAssistant({
          stopReason: "toolUse",
          model: "gpt-5.4",
          content: [
            {
              type: "tool_use",
              id: "tool_1",
              name: "image_generate",
              input: { action: "generate", prompt: "a portrait" },
            },
          ],
        }),
      }),
    );

    expect(incompleteTurnText).toBeNull();
  });

  it("surfaces tool-use terminal with pre-tool text and side effects as replay-unsafe (#76477)", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams(
        {
          assistantTexts: ["Let me update the file..."],
          toolMetas: [{ toolName: "write" }],
          lastAssistant: makeLastAssistant({
            stopReason: "toolUse",
            model: "gpt-5.4",
            content: [
              { type: "text", text: "Let me update the file..." },
              { type: "tool_use", id: "tool_1", name: "write", input: {} },
            ],
          }),
        },
        { payloadCount: 1 },
      ),
    );

    expect(incompleteTurnText).toContain("verify before retrying");
  });

  it("does not flag a completed tool-use turn with end_turn as incomplete (#76477)", () => {
    // When the model successfully produces post-tool text, lastAssistant has
    // stopReason=end_turn. The incomplete-turn guard should not fire.
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams(
        {
          assistantTexts: ["Initial analysis...", "Here is the final answer."],
          toolMetas: [{ toolName: "read" }],
          lastAssistant: makeLastAssistant({
            stopReason: "end_turn",
            provider: "anthropic",
            model: "sonnet-4.6",
            content: [{ type: "text", text: "Here is the final answer." }],
          }),
        },
        { payloadCount: 1 },
      ),
    );

    expect(incompleteTurnText).toBeNull();
  });

  it("surfaces stall on clean stop with only an unsigned thinking payload (payloadCount=1, no visible text)", () => {
    // Regression: unsigned thinking payloads increment payloadCount but carry no
    // user-visible content. The visible-text guard must not suppress incomplete-turn
    // detection when the model produced only a thinking block and no answer. (#89787)
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams(
        {
          assistantTexts: [],
          lastAssistant: makeLastAssistant({
            model: "qwen3.6-35b-a3b",
            content: [
              {
                type: "thinking",
                thinking: "let me plan the tool calls I need to make...",
                // no signature — unsigned thinking block
              },
            ],
          }),
        },
        { payloadCount: 1 },
      ),
    );

    expect(incompleteTurnText).toContain("couldn't generate a response");
  });

  it("does not surface a stall when unsigned thinking accompanies visible text (payloadCount=1)", () => {
    // When the model emits both a thinking block and a visible text answer, the turn
    // succeeded and no stall should be surfaced even though thinking is unsigned.
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams(
        {
          assistantTexts: ["Here is the answer to your question."],
          lastAssistant: makeLastAssistant({
            model: "qwen3.6-35b-a3b",
            content: [
              {
                type: "thinking",
                thinking: "let me answer this...",
              },
              { type: "text", text: "Here is the answer to your question." },
            ],
          }),
        },
        { payloadCount: 1 },
      ),
    );

    expect(incompleteTurnText).toBeNull();
  });

  it("surfaces an error for tool-use terminal turn with pre-tool text via runEmbeddedAgent (#76477)", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Initial analysis of the issue..."],
        toolMetas: [{ toolName: "read", meta: "path=src/index.ts" }],
        lastAssistant: {
          stopReason: "toolUse",
          provider: "anthropic",
          model: "sonnet-4.6",
          content: [
            { type: "text", text: "Initial analysis of the issue..." },
            { type: "tool_use", id: "tool_1", name: "read", input: { path: "src/index.ts" } },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent(
      makeRunParams("run-tool-use-dropped-final-text", {
        provider: "anthropic",
        model: "sonnet-4.6",
      }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("couldn't generate a response");
    expectWarnMessageWith("incomplete turn detected");
  });

  it("delivers the current final answer when the session assistant is stale (#80918)", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    const finalText = "The requested update is complete.";
    mockedBuildEmbeddedRunPayloads.mockReturnValueOnce([{ text: finalText }]);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [finalText],
        toolMetas: [{ toolName: "update_plan", replaySafe: true }],
        lastAssistant: makeLastAssistant({
          stopReason: "toolUse",
          content: [{ type: "tool_use", id: "tool_1", name: "update_plan", input: {} }],
          usage: { input: 100, output: 5, total: 105 },
        }),
        currentAttemptAssistant: makeLastAssistant({
          content: [{ type: "text", text: finalText }],
          usage: { input: 200, output: 20, total: 220 },
        }),
      }),
    );

    const result = await runEmbeddedAgent(makeRunParams("run-current-assistant-after-tool-use"));

    expect(result.payloads).toEqual([{ text: finalText }]);
    expect(mockedBuildEmbeddedRunPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        currentAssistant: expect.objectContaining({
          stopReason: "stop",
          content: [{ type: "text", text: finalText }],
        }),
        lastAssistant: expect.objectContaining({
          stopReason: "stop",
          content: [{ type: "text", text: finalText }],
        }),
      }),
    );
    expect(result.meta.finalAssistantVisibleText).toBe(finalText);
    expect(result.meta.stopReason).toBe("stop");
    expect(result.meta.agentMeta?.lastCallUsage).toMatchObject({
      input: 200,
      output: 20,
      total: 220,
    });
    expectNoWarnMessageWith("incomplete turn detected");
  });

  it("treats missing replay metadata as replay-invalid", () => {
    const attempt = makeAttemptResult();
    delete (attempt as Partial<EmbeddedRunAttemptResult>).replayMetadata;

    const normalizedAttempt = normalizeEmbeddedRunAttemptResult(attempt);

    expect(normalizedAttempt.replayMetadata).toEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
    expect(resolveReplayInvalidFlag({ attempt: normalizedAttempt })).toBe(true);
  });

  it("detects reasoning-only GPT turns from signed thinking blocks", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction(
      makeReasoningRetryParams({
        assistantTexts: [],
        lastAssistant: makeLastAssistant({
          stopReason: "end_turn",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_helper", type: "reasoning" }),
            },
          ],
        }),
      }),
    );

    expect(retryInstruction).toBe(REASONING_ONLY_RETRY_INSTRUCTION);
  });

  it("detects reasoning-only Gemini turns from signed thinking blocks", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction(
      makeReasoningRetryParams(
        {
          assistantTexts: [],
          lastAssistant: makeLastAssistant({
            stopReason: "end_turn",
            provider: "google",
            model: "gemini-2.5-pro",
            content: [
              {
                type: "thinking",
                thinking: "internal reasoning",
                thinkingSignature: JSON.stringify({ id: "gemini_rs_helper", type: "reasoning" }),
              },
            ],
          }),
        },
        { provider: "google", modelId: "gemini-2.5-pro" },
      ),
    );

    expect(retryInstruction).toBe(REASONING_ONLY_RETRY_INSTRUCTION);
  });

  it("retries signed reasoning-only Bedrock Converse turns with a visible-answer continuation", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction(
      makeReasoningRetryParams(
        {
          assistantTexts: [],
          lastAssistant: makeLastAssistant({
            provider: "amazon-bedrock",
            model: "openai.gpt-oss-120b-1:0",
            content: [
              {
                type: "thinking",
                thinking: "internal reasoning",
                thinkingSignature: "bedrock-reasoning-signature",
              },
            ],
          }),
        },
        {
          provider: "amazon-bedrock",
          modelId: "openai.gpt-oss-120b-1:0",
          modelApi: "bedrock-converse-stream",
        },
      ),
    );

    expect(retryInstruction).toBe(REASONING_ONLY_RETRY_INSTRUCTION);
  });

  it("retries signed reasoning-only Ollama turns with a visible-answer continuation instruction", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction(
      makeReasoningRetryParams(
        {
          assistantTexts: [],
          lastAssistant: makeLastAssistant({
            stopReason: "end_turn",
            provider: "ollama",
            model: "gemma4:31b",
            content: [
              {
                type: "thinking",
                thinking: "internal reasoning",
                thinkingSignature: JSON.stringify({ id: "ollama_rs_helper", type: "reasoning" }),
              },
            ],
          }),
        },
        { provider: "ollama", modelId: "gemma4:31b" },
      ),
    );

    expect(retryInstruction).toBe(REASONING_ONLY_RETRY_INSTRUCTION);
  });

  it("retries unsigned thinking-only turns via the reasoning-only path (openai-completions)", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction(
      makeReasoningRetryParams(
        {
          assistantTexts: [],
          lastAssistant: makeLastAssistant({
            model: "qwen3.6-35b-a3b",
            content: [
              {
                type: "thinking",
                thinking: "let me plan the tool calls I need to make...",
              },
            ],
          }),
        },
        { modelId: "qwen3.6-35b-a3b", modelApi: "openai-completions" },
      ),
    );

    expect(retryInstruction).toBe(REASONING_ONLY_RETRY_INSTRUCTION);
  });

  it("retries unsigned thinking-only Ollama turns via the reasoning-only path", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction(
      makeReasoningRetryParams(
        {
          assistantTexts: [],
          lastAssistant: makeLastAssistant({
            stopReason: "end_turn",
            provider: "ollama",
            model: "gemma4:31b",
            content: [
              {
                type: "thinking",
                thinking: "internal reasoning",
              },
            ],
          }),
        },
        { provider: "ollama", modelId: "gemma4:31b" },
      ),
    );

    expect(retryInstruction).toBe(REASONING_ONLY_RETRY_INSTRUCTION);
  });

  it("retries unsigned-thinking Ollama turns via the empty-response path", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction(
      makeEmptyResponseRetryParams(
        {
          assistantTexts: [],
          lastAssistant: makeLastAssistant({
            stopReason: "end_turn",
            provider: "ollama",
            model: "gemma4:31b",
            content: [
              {
                type: "thinking",
                thinking: "internal reasoning",
              },
            ],
          }),
        },
        { provider: "ollama", modelId: "gemma4:31b" },
      ),
    );

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("retries generic empty Ollama turns without visible text", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction(
      makeEmptyResponseRetryParams(
        {
          assistantTexts: [],
          lastAssistant: makeLastAssistant({
            stopReason: "end_turn",
            provider: "ollama",
            model: "gemma4:31b",
            content: [{ type: "text", text: "" }],
          }),
        },
        { provider: "ollama", modelId: "gemma4:31b" },
      ),
    );

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("retries empty Ollama stop turns when nonzero output tokens were generated", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction(
      makeEmptyResponseRetryParams(
        {
          assistantTexts: [],
          lastAssistant: makeLastAssistant({
            provider: "ollama",
            model: "minimax-m2.7:cloud",
            usage: { input: 100, output: 6, totalTokens: 106 },
          }),
        },
        { provider: "ollama", modelId: "minimax-m2.7:cloud" },
      ),
    );

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("does not retry empty turns after an accepted sessions_spawn delivery", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction(
      makeEmptyResponseRetryParams(
        {
          assistantTexts: [],
          acceptedSessionSpawns: [
            {
              runId: "run-child",
              childSessionKey: "agent:claude:subagent:child",
            },
          ],
          lastAssistant: makeLastAssistant({
            stopReason: "end_turn",
            provider: "ollama",
            model: "gemma4:31b",
            content: [{ type: "text", text: "" }],
          }),
        },
        { provider: "ollama", modelId: "gemma4:31b" },
      ),
    );

    expect(retryInstruction).toBeNull();
  });

  it("retries empty openai-chatgpt-responses turns with non-zero output tokens (#85364)", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction(
      makeEmptyResponseRetryParams(
        {
          assistantTexts: [],
          lastAssistant: makeLastAssistant({
            usage: { input: 24794, output: 111, cacheRead: 4608, totalTokens: 29513 },
          }),
        },
        { modelId: "gpt-5.5", modelApi: "openai-chatgpt-responses" },
      ),
    );

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("retries empty openai-responses turns without visible text", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction(
      makeEmptyResponseRetryParams(
        {
          assistantTexts: [],
          lastAssistant: makeLastAssistant({
            usage: { input: 5000, output: 200, totalTokens: 5200 },
          }),
        },
        { modelId: "gpt-5.5", modelApi: "openai-responses" },
      ),
    );

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("retries generic empty OpenAI-compatible turns from custom endpoints", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction(
      makeEmptyResponseRetryParams(
        {
          assistantTexts: [],
          lastAssistant: makeLastAssistant({
            provider: "llama-cpp-local",
            model: "qwen3.6-27b",
            usage: { input: 950, output: 103, totalTokens: 1053 },
          }),
        },
        {
          provider: "llama-cpp-local",
          modelId: "qwen3.6-27b",
          modelApi: "openai-completions",
        },
      ),
    );

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("does not retry clean zero-token Ollama stop turns", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction(
      makeEmptyResponseRetryParams(
        {
          assistantTexts: [],
          lastAssistant: makeLastAssistant({
            provider: "ollama",
            model: "glm-5.1:cloud",
            usage: { input: 100, output: 0, totalTokens: 100 },
          }),
        },
        { provider: "ollama", modelId: "glm-5.1:cloud" },
      ),
    );

    expect(retryInstruction).toBeNull();
  });

  it("treats exact NO_REPLY as a deliberate silent assistant reply", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams({
        assistantTexts: ["NO_REPLY"],
        lastAssistant: makeLastAssistant({
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_no_reply", type: "reasoning" }),
            },
            { type: "text", text: "" },
            { type: "text", text: "NO_REPLY" },
          ],
        }),
      }),
    );

    expect(incompleteTurnText).toBeNull();
  });

  it("suppresses the incomplete-turn warning after committed messaging text delivery", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams({
        assistantTexts: [],
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["Delivered through the message tool."],
        lastAssistant: makeLastAssistant({
          provider: "ollama",
          model: "kimi-k2.6:cloud",
        }),
      }),
    );

    expect(incompleteTurnText).toBeNull();
  });

  it("suppresses the incomplete-turn warning after committed messaging delivery before end_turn", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams({
        assistantTexts: [],
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["Delivered through the message tool."],
        lastAssistant: makeLastAssistant({
          stopReason: "end_turn",
          provider: "google",
          model: "gemini-2.5-pro",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_messaging_end_turn", type: "reasoning" }),
            },
          ],
        }),
      }),
    );

    expect(incompleteTurnText).toBeNull();
  });

  it("suppresses the incomplete-turn warning after committed media-only messaging delivery", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams({
        assistantTexts: [],
        didSendViaMessagingTool: false,
        messagingToolSentMediaUrls: ["file:///tmp/render.png"],
        lastAssistant: makeLastAssistant({
          stopReason: "end_turn",
          model: "gpt-5.4",
        }),
      }),
    );

    expect(incompleteTurnText).toBeNull();
  });

  it("suppresses the incomplete-turn warning after committed messaging delivery even when the provider errored", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams({
        assistantTexts: [],
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["Delivered before the provider error."],
        lastAssistant: makeLastAssistant({
          stopReason: "error",
          provider: "ollama",
          model: "kimi-k2.6:cloud",
          errorMessage: "provider failed after delivery",
        }),
      }),
    );

    expect(incompleteTurnText).toBeNull();
  });

  it("suppresses the incomplete-turn warning after an accepted sessions_spawn terminal success", () => {
    const attemptWithAcceptedSpawn: Partial<EmbeddedRunAttemptResult> & {
      acceptedSessionSpawns: Array<{ runId: string; childSessionKey: string }>;
    } = {
      assistantTexts: [],
      acceptedSessionSpawns: [
        {
          runId: "run-child",
          childSessionKey: "agent:claude:subagent:child",
        },
      ],
      lastAssistant: makeLastAssistant({
        provider: "anthropic",
        model: "sonnet-4.6",
      }),
    };

    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams(attemptWithAcceptedSpawn),
    );

    expect(incompleteTurnText).toBeNull();
  });

  it("still returns a timeout payload when the parent prompt times out after an accepted sessions_spawn", async () => {
    const acceptedSessionSpawns = [
      {
        runId: "run-child",
        childSessionKey: "agent:claude:subagent:child",
      },
    ];
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        acceptedSessionSpawns,
        timedOut: true,
        lastAssistant: makeLastAssistant({
          stopReason: "toolUse",
          model: "gpt-5.4",
        }),
      }),
    );

    const result = await runEmbeddedAgent(
      makeRunParams("run-timeout-after-accepted-spawn", { model: "gpt-5.4" }),
    );

    expect(result.payloads).toEqual([
      {
        text: "Request timed out before a response was generated. Please try again, or increase `agents.defaults.timeoutSeconds` in your config.",
        isError: true,
      },
    ]);
    expect(result.acceptedSessionSpawns).toEqual(acceptedSessionSpawns);
  });

  it("still surfaces the incomplete-turn warning without an accepted sessions_spawn success", () => {
    const attemptWithMalformedSpawn: Partial<EmbeddedRunAttemptResult> & {
      acceptedSessionSpawns: Array<{ runId: string; childSessionKey: string }>;
    } = {
      assistantTexts: [],
      acceptedSessionSpawns: [],
      lastAssistant: makeLastAssistant({
        provider: "anthropic",
        model: "sonnet-4.6",
      }),
    };

    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams(attemptWithMalformedSpawn),
    );

    expect(incompleteTurnText).toContain("couldn't generate a response");
  });

  it("still surfaces the incomplete-turn warning when no messaging delivery was committed", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams({
        assistantTexts: [],
        didSendViaMessagingTool: true,
        lastAssistant: makeLastAssistant({
          stopReason: "error",
          provider: "ollama",
          model: "kimi-k2.6:cloud",
          errorMessage: "provider failed mid-turn",
        }),
      }),
    );

    expect(incompleteTurnText).toContain("verify before retrying");
  });

  it("does not treat empty committed messaging arrays as delivery", () => {
    expect(
      hasCommittedMessagingToolDeliveryEvidence({
        messagingToolSentTexts: ["  "],
        messagingToolSentMediaUrls: [],
      }),
    ).toBe(false);
  });

  it("treats committed messaging media as delivery", () => {
    expect(
      hasCommittedMessagingToolDeliveryEvidence({
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: ["file:///tmp/render.png"],
      }),
    ).toBe(true);
  });

  it("treats committed messaging targets as delivery", () => {
    expect(
      hasCommittedMessagingToolDeliveryEvidence({
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [{ tool: "message", provider: "slack", to: "channel-1" }],
      }),
    ).toBe(true);
  });

  for (const { name, overrides } of [
    {
      name: "treats committed messaging text as replay-invalid side effect metadata",
      overrides: { messagingToolSentTexts: ["Delivered through the message tool."] },
    },
    {
      name: "treats async-started background tools as replay-invalid side effects",
      overrides: { toolMetas: [{ toolName: "image_generate", asyncStarted: true }] },
    },
    {
      name: "treats committed messaging media as replay-invalid side effect metadata",
      overrides: { messagingToolSentMediaUrls: ["file:///tmp/render.png"] },
    },
    {
      name: "treats committed messaging targets as replay-invalid side effect metadata",
      overrides: {
        messagingToolSentTargets: [{ tool: "message", provider: "slack", to: "channel-1" }],
      },
    },
  ]) {
    it(name, () => {
      expect(
        buildAttemptReplayMetadata({
          toolMetas: [],
          didSendViaMessagingTool: false,
          messagingToolSentTexts: [],
          messagingToolSentMediaUrls: [],
          ...overrides,
        }),
      ).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
    });
  }

  it("treats accepted sessions_spawn as replay-invalid outbound delivery", () => {
    const acceptedSessionSpawns = [
      {
        runId: "run-child",
        childSessionKey: "agent:claude:subagent:child",
      },
    ];

    expect(
      buildAttemptReplayMetadata({
        toolMetas: [],
        didSendViaMessagingTool: false,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        acceptedSessionSpawns,
      }),
    ).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
    expect(hasOutboundDeliveryEvidence({ acceptedSessionSpawns })).toBe(true);
  });

  it("ignores malformed accepted sessions_spawn delivery evidence", () => {
    expect(
      hasOutboundDeliveryEvidence({
        acceptedSessionSpawns: [
          null,
          {
            runId: "run-child",
            childSessionKey: " ",
          },
        ],
      }),
    ).toBe(false);
  });

  it("leaves committed delivery plus tool errors to the tool-error payload path", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams({
        assistantTexts: [],
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["Delivered through the message tool."],
        lastToolError: {
          toolName: "message",
          meta: "send",
          error: "delivery failed for second target",
        },
        lastAssistant: makeLastAssistant({
          stopReason: "error",
          model: "gpt-5.4",
        }),
      }),
    );

    expect(incompleteTurnText).toBeNull();
  });

  it("does not retry reasoning-only GPT turns after side effects", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction(
      makeReasoningRetryParams({
        assistantTexts: [],
        didSendViaMessagingTool: true,
        lastAssistant: makeLastAssistant({
          stopReason: "end_turn",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_side_effect", type: "reasoning" }),
            },
          ],
        }),
      }),
    );

    expect(retryInstruction).toBeNull();
    expect(DEFAULT_REASONING_ONLY_RETRY_LIMIT).toBe(2);
  });

  it("does not retry reasoning-only GPT turns when the assistant ended in error", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction(
      makeReasoningRetryParams({
        assistantTexts: [],
        lastAssistant: makeLastAssistant({
          stopReason: "error",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_helper_error", type: "reasoning" }),
            },
          ],
        }),
      }),
    );

    expect(retryInstruction).toBeNull();
  });

  it("does not retry reasoning-only GPT turns when visible assistant text already exists", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction(
      makeReasoningRetryParams({
        assistantTexts: ["Visible answer."],
        lastAssistant: makeLastAssistant({
          stopReason: "end_turn",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({
                id: "rs_helper_visible_text",
                type: "reasoning",
              }),
            },
            { type: "text", text: "" },
          ],
        }),
      }),
    );

    expect(retryInstruction).toBeNull();
  });

  it("surfaces incomplete-turn text for errored signed-thinking-only turns with payloads", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams(
        {
          assistantTexts: [],
          lastAssistant: makeLastAssistant({
            stopReason: "error",
            provider: "anthropic",
            model: "claude-opus-4-8",
            content: [
              {
                type: "thinking",
                thinking: "internal reasoning before provider error",
                thinkingSignature: JSON.stringify({ id: "rs_error_payload", type: "reasoning" }),
              },
            ],
          }),
        },
        { payloadCount: 1 },
      ),
    );

    expect(incompleteTurnText).toContain("couldn't generate a response");
  });

  it("surfaces incomplete-turn text for token-limited partial answers", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams(
        {
          assistantTexts: ["Partial answer"],
          lastAssistant: makeLastAssistant({
            stopReason: "length",
            provider: "ollama",
            model: "qwen3.5",
            content: [{ type: "text", text: "Partial answer" }],
          }),
        },
        { payloadCount: 1 },
      ),
    );

    expect(incompleteTurnText).toContain("couldn't generate a response");
  });

  it("keeps complete visible stop turns successful", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams(
        {
          assistantTexts: ["Complete answer"],
          lastAssistant: makeLastAssistant({
            provider: "ollama",
            model: "qwen3.5",
            content: [{ type: "text", text: "Complete answer" }],
          }),
        },
        { payloadCount: 1 },
      ),
    );

    expect(incompleteTurnText).toBeNull();
  });

  it("preserves terminal tool media on token-limited turns", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams(
        {
          assistantTexts: ["Partial answer"],
          toolMediaUrls: ["file:///tmp/render.png"],
          lastAssistant: makeLastAssistant({
            stopReason: "length",
            provider: "ollama",
            model: "qwen3.5",
            content: [{ type: "text", text: "Partial answer" }],
          }),
        },
        { payloadCount: 1 },
      ),
    );

    expect(incompleteTurnText).toBeNull();
  });

  it("preserves tool media already delivered through block replies", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams(
        {
          assistantTexts: ["Partial answer"],
          hasToolMediaBlockReply: true,
          lastAssistant: makeLastAssistant({
            stopReason: "length",
            provider: "ollama",
            model: "qwen3.5",
            content: [{ type: "text", text: "Partial answer" }],
          }),
        },
        { payloadCount: 1 },
      ),
    );

    expect(incompleteTurnText).toBeNull();
  });

  it("preserves successful cron progress on token-limited turns", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams(
        {
          assistantTexts: ["Partial answer"],
          successfulCronAdds: 1,
          lastAssistant: makeLastAssistant({
            stopReason: "length",
            provider: "ollama",
            model: "qwen3.5",
            content: [{ type: "text", text: "Partial answer" }],
          }),
        },
        { payloadCount: 1 },
      ),
    );

    expect(incompleteTurnText).toBeNull();
  });

  it.each([
    [
      "heartbeat responses",
      {
        heartbeatToolResponse: {
          outcome: "progress" as const,
          notify: false,
          summary: "Still working",
        },
      },
    ],
    ["tool media", { toolMediaUrls: ["file:///tmp/render.png"] }],
    ["voice media", { toolAudioAsVoice: true }],
    ["trusted local media", { toolTrustedLocalMedia: true }],
    [
      "source reply payloads",
      { messagingToolSourceReplyPayloads: [{ text: "Delivered through the source reply." }] },
    ],
    ["delivered source replies", { didDeliverSourceReplyViaMessageTool: true }],
  ] satisfies Array<[string, Partial<EmbeddedRunAttemptResult>]>)(
    "does not replace terminal %s with an incomplete-turn warning",
    (_label, attemptState) => {
      const incompleteTurnText = resolveIncompleteTurnPayloadText(
        makeIncompleteTurnParams(
          {
            assistantTexts: [],
            ...attemptState,
            lastAssistant: makeLastAssistant({
              stopReason: "error",
              provider: "anthropic",
              model: "claude-opus-4-8",
              content: [
                {
                  type: "thinking",
                  thinking: "internal reasoning before provider error",
                  thinkingSignature: JSON.stringify({
                    id: "rs_terminal_payload",
                    type: "reasoning",
                  }),
                },
              ],
            }),
          },
          { payloadCount: 1 },
        ),
      );

      expect(incompleteTurnText).toBeNull();
    },
  );

  it("retries replay-safe errored turns that only emitted thinking blocks", () => {
    const assistant = makeLastAssistant({
      stopReason: "error",
      provider: "anthropic",
      model: "claude-opus-4-8",
      content: [
        {
          type: "thinking",
          thinking: "internal reasoning before provider error",
          thinkingSignature: JSON.stringify({ id: "rs_error", type: "reasoning" }),
        },
        { type: "redacted_thinking", data: "opaque" },
        { type: "text", text: " " },
      ],
      usage: { input: 100, output: 1120, totalTokens: 1220 },
    });
    expect(
      shouldRetrySilentErrorAssistantTurn({
        attempt: makeAttemptResult({ assistantTexts: [], lastAssistant: assistant }),
        assistant,
      }),
    ).toBe(true);
  });

  it("does not retry an ambiguous post-dispatch provider outcome", () => {
    const assistant = makeLastAssistant({
      stopReason: "error",
      errorCode: PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE,
      errorMessage: "The WebSocket closed after dispatch",
      usage: { input: 100, output: 0, totalTokens: 100 },
    });
    expect(
      shouldRetrySilentErrorAssistantTurn({
        attempt: makeAttemptResult({ assistantTexts: [], lastAssistant: assistant }),
        assistant,
      }),
    ).toBe(false);
  });

  it("does not retry errored empty turns when non-zero output may indicate progress", () => {
    const assistant = makeLastAssistant({
      stopReason: "error",
      provider: "ollama",
      model: "glm-5.1:cloud",
      usage: { input: 100, output: 12, totalTokens: 112 },
    });
    expect(
      shouldRetrySilentErrorAssistantTurn({
        attempt: makeAttemptResult({ assistantTexts: [], lastAssistant: assistant }),
        assistant,
      }),
    ).toBe(false);
  });

  it.each([
    {
      name: "visible text",
      content: [
        { type: "thinking", thinking: "internal", thinkingSignature: "sig" },
        { type: "text", text: "partial answer" },
      ],
    },
    {
      name: "tool call",
      content: [
        { type: "thinking", thinking: "internal", thinkingSignature: "sig" },
        { type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } },
      ],
    },
    {
      name: "unknown block",
      content: [{ type: "provider_metadata", value: "opaque" }],
    },
  ])("does not retry errored turns containing $name", ({ content }) => {
    const assistant = makeLastAssistant({
      stopReason: "error",
      provider: "anthropic",
      model: "claude-opus-4-8",
      content,
      usage: { input: 100, output: 1120, totalTokens: 1220 },
    });
    expect(
      shouldRetrySilentErrorAssistantTurn({
        attempt: makeAttemptResult({ assistantTexts: [], lastAssistant: assistant }),
        assistant,
      }),
    ).toBe(false);
  });

  it("does not retry errored thinking-only turns after side effects", () => {
    const assistant = makeLastAssistant({
      stopReason: "error",
      provider: "anthropic",
      model: "claude-opus-4-8",
      content: [
        {
          type: "redacted_thinking",
          data: "opaque",
        },
      ],
      usage: { input: 100, output: 1120, totalTokens: 1220 },
    });
    expect(
      shouldRetrySilentErrorAssistantTurn({
        attempt: makeAttemptResult({
          assistantTexts: [],
          replayMetadata: {
            hadPotentialSideEffects: true,
            replaySafe: false,
          },
          lastAssistant: assistant,
        }),
        assistant,
      }),
    ).toBe(false);
  });

  it.each([
    ["current clean overrides cumulative dirty", true, false, true],
    ["current dirty overrides cumulative clean", false, true, false],
    ["both clean remain retryable", false, false, true],
  ] as const)(
    "uses current-attempt replay metadata when %s",
    (_label, cumulativeDirty, currentDirty, expected) => {
      const assistant = makeLastAssistant({
        stopReason: "error",
        provider: "openrouter",
        model: "test-model",
        usage: { input: 100, output: 0, totalTokens: 100 },
      });
      expect(
        shouldRetrySilentErrorAssistantTurn({
          attempt: makeAttemptResult({
            assistantTexts: [],
            lastAssistant: assistant,
            replayMetadata: {
              hadPotentialSideEffects: cumulativeDirty,
              replaySafe: !cumulativeDirty,
            },
            currentAttemptReplayMetadata: {
              hadPotentialSideEffects: currentDirty,
              replaySafe: !currentDirty,
            },
          }),
          assistant,
        }),
      ).toBe(expected);
    },
  );

  it("detects empty openai-compatible stop turns with non-zero output usage", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction(
      makeEmptyResponseRetryParams(
        {
          assistantTexts: [],
          lastAssistant: makeLastAssistant({
            provider: "llamacpp",
            model: "qwen3.6-27b",
            usage: { input: 512, output: 103, totalTokens: 615 },
          }),
        },
        { provider: "llamacpp", modelId: "qwen3.6-27b", modelApi: "openai-completions" },
      ),
    );

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("detects generic empty GPT turns without visible text", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction(
      makeEmptyResponseRetryParams({
        assistantTexts: [],
        lastAssistant: makeLastAssistant({
          stopReason: "end_turn",
          model: "gpt-5.4",
          content: [{ type: "text", text: "" }],
        }),
      }),
    );

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    expect(DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT).toBe(1);
  });

  it("surfaces empty Codex app-server replies after successful sparse bash output", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams({
        assistantTexts: [],
        toolMetas: [{ toolName: "bash", meta: "exit=0" }],
        messagesSnapshot: [
          {
            role: "toolResult",
            content: [{ type: "text", text: "" }],
            details: { aggregated: "" },
          } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
          makeLastAssistant({
            content: [{ type: "text", text: "" }],
          }),
        ],
        lastAssistant: makeLastAssistant({
          content: [{ type: "text", text: "" }],
        }),
      }),
    );

    expect(incompleteTurnText).toContain("couldn't generate a response");
    expect(incompleteTurnText).toContain("verify before retrying");
  });

  it("retries generic empty Bedrock Converse turns without visible text", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction(
      makeEmptyResponseRetryParams(
        {
          assistantTexts: [],
          lastAssistant: makeLastAssistant({
            provider: "amazon-bedrock",
            model: "openai.gpt-oss-120b-1:0",
            content: [{ type: "text", text: "" }],
            usage: { input: 950, output: 103, totalTokens: 1053 },
          }),
        },
        {
          provider: "amazon-bedrock",
          modelId: "openai.gpt-oss-120b-1:0",
          modelApi: "bedrock-converse-stream",
        },
      ),
    );

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("treats clean empty assistant turns as silent only for reply-optional runs", () => {
    const attempt = makeAttemptResult({
      assistantTexts: [],
      lastAssistant: makeLastAssistant({
        content: [{ type: "text", text: "" }],
      }),
    });

    expect(shouldTreatEmptyAssistantReplyAsSilent(makeSilentReplyParams(attempt))).toBe(false);
    expect(
      shouldTreatEmptyAssistantReplyAsSilent(
        makeSilentReplyParams(attempt, { terminalReplyExpectation: "optional" }),
      ),
    ).toBe(true);
    expect(
      shouldTreatEmptyAssistantReplyAsSilent(
        makeSilentReplyParams(attempt, { allowEmptyAssistantReplyAsSilent: false }),
      ),
    ).toBe(false);
  });

  it("treats reasoning-only assistant turns as silent only for reply-optional runs", () => {
    const attempt = makeAttemptResult({
      assistantTexts: [],
      lastAssistant: makeLastAssistant({
        stopReason: "end_turn",
        content: [
          {
            type: "thinking",
            thinking: "internal reasoning",
            thinkingSignature: JSON.stringify({ id: "rs_silent_helper", type: "reasoning" }),
          },
        ],
      }),
    });

    expect(shouldTreatEmptyAssistantReplyAsSilent(makeSilentReplyParams(attempt))).toBe(false);
    expect(
      shouldTreatEmptyAssistantReplyAsSilent(
        makeSilentReplyParams(attempt, { terminalReplyExpectation: "optional" }),
      ),
    ).toBe(true);
    expect(
      shouldTreatEmptyAssistantReplyAsSilent(
        makeSilentReplyParams(attempt, { allowEmptyAssistantReplyAsSilent: false }),
      ),
    ).toBe(false);
  });

  it("treats exact NO_REPLY assistant turns as silent only when the caller allows it", () => {
    const attempt = makeAttemptResult({
      assistantTexts: ["NO_REPLY"],
      lastAssistant: makeLastAssistant({
        content: [{ type: "text", text: "NO_REPLY" }],
      }),
    });

    expect(shouldTreatEmptyAssistantReplyAsSilent(makeSilentReplyParams(attempt))).toBe(true);
    expect(
      shouldTreatEmptyAssistantReplyAsSilent(
        makeSilentReplyParams(attempt, { allowEmptyAssistantReplyAsSilent: false }),
      ),
    ).toBe(false);
  });

  it("treats post-tool exact NO_REPLY assistant turns as intentional silence", () => {
    const attempt = makeAttemptResult({
      assistantTexts: ["NO_REPLY"],
      toolMetas: [{ toolName: "process.poll", meta: "pid=123", replaySafe: true }],
      lastAssistant: makeLastAssistant({
        content: [{ type: "text", text: "NO_REPLY" }],
      }),
    });

    expect(shouldTreatEmptyAssistantReplyAsSilent(makeSilentReplyParams(attempt))).toBe(true);
  });

  it("does not treat error or side-effect empty turns as silent", () => {
    const errorAttempt = makeAttemptResult({
      assistantTexts: [],
      lastAssistant: makeLastAssistant({
        stopReason: "error",
      }),
    });
    const silentErrorAttempt = makeAttemptResult({
      assistantTexts: ["NO_REPLY"],
      lastAssistant: makeLastAssistant({
        stopReason: "error",
        content: [{ type: "text", text: "NO_REPLY" }],
      }),
    });
    const sideEffectAttempt = makeAttemptResult({
      assistantTexts: [],
      didSendViaMessagingTool: true,
      messagingToolSentTexts: ["sent already"],
      lastAssistant: makeLastAssistant({
        content: [{ type: "text", text: "" }],
      }),
    });
    const postToolEmptyAttempt = makeAttemptResult({
      assistantTexts: [],
      toolMetas: [{ toolName: "process.poll", meta: "pid=123", replaySafe: true }],
      lastAssistant: makeLastAssistant({
        api: "openai-completions",
        provider: "stepfun",
        model: "step-router-v1",
      }),
    });

    expect(shouldTreatEmptyAssistantReplyAsSilent(makeSilentReplyParams(errorAttempt))).toBe(false);
    expect(shouldTreatEmptyAssistantReplyAsSilent(makeSilentReplyParams(silentErrorAttempt))).toBe(
      false,
    );
    expect(shouldTreatEmptyAssistantReplyAsSilent(makeSilentReplyParams(sideEffectAttempt))).toBe(
      false,
    );
    expect(
      shouldTreatEmptyAssistantReplyAsSilent(makeSilentReplyParams(postToolEmptyAttempt)),
    ).toBe(false);
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
