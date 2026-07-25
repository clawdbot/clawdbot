// Coverage for incomplete-turn safety, retry instructions, and liveness states.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { registerAgentHarness } from "../harness/registry.js";
import {
  hasCommittedMessagingToolDeliveryEvidence,
  hasOutboundDeliveryEvidence,
} from "./delivery-evidence.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedBuildEmbeddedRunPayloads,
  mockedClassifyFailoverReason,
  mockedGlobalHookRunner,
  mockedIsFailoverAssistantError,
  mockedIsRateLimitAssistantError,
  mockedLog,
  mockedRunEmbeddedAttempt,
  mockedResolveModelAsync,
  mockedSleepWithAbort,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
  useOpenAIPlatformAuthFixture,
  warmRunOverflowCompactionHarness,
} from "./run.overflow-compaction.harness.js";
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
import type { EmbeddedRunAttemptResult } from "./run/types.js";

const REASONING_ONLY_RETRY_INSTRUCTION =
  "The previous assistant turn recorded reasoning but did not produce a user-visible answer. Continue from that partial turn and produce the visible answer now. Do not restate the reasoning or restart from scratch.";
const EMPTY_RESPONSE_RETRY_INSTRUCTION =
  "The previous attempt did not produce a user-visible answer. Continue from the current state and produce the visible answer now. Do not restart from scratch.";
const SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION =
  "The previous assistant turn completed its tool calls but did not produce a user-visible answer. Continue from the current transcript and produce the final user-visible answer now. Do not repeat completed tool calls or restart from scratch.";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

function resolveIncompleteTurnPayloadText(
  params: Omit<Parameters<typeof resolveIncompleteTurnPayloadTextCore>[0], "externalAbort"> & {
    externalAbort?: boolean;
  },
): string | null {
  // Most helper tests exercise internal abort behavior; external aborts opt in
  // explicitly through params.
  return resolveIncompleteTurnPayloadTextCore({ externalAbort: false, ...params });
}

describe("runEmbeddedAgent incomplete-turn safety", () => {
  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
    await warmRunOverflowCompactionHarness(runEmbeddedAgent);
  }, 300_000);

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    useOpenAIPlatformAuthFixture();
    mockedGlobalHookRunner.hasHooks.mockImplementation(() => false);
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

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-tool-summary-failure-count",
    });

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

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-before-agent-run-hook-block",
    });

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

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-4.1",
      runId: "run-incomplete-turn-messaging-warning",
    });

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
        lastAssistant: {
          role: "assistant",
          stopReason: "toolUse",
          provider: "openai",
          model: "gpt-5.5",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-internal-abort-tool-use-incomplete",
    });

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
    const interruptedAssistant = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "HTTP 429 Too Many Requests",
      provider: "openai",
      model: "gpt-5.5",
      content: [],
    } as unknown as NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;
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

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-caller-timeout",
      abortSignal: controller.signal,
    });

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
    const lateAssistant = {
      role: "assistant",
      stopReason: "stop",
      provider: "openai",
      model: "gpt-5.5",
      content: [{ type: "text", text: "Late answer" }],
    } as unknown as NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;
    mockedRunEmbeddedAttempt.mockImplementationOnce(async () => {
      controller.abort(abortError);
      return makeAttemptResult({
        assistantTexts: ["Late answer"],
        lastAssistant: lateAssistant,
        currentAttemptAssistant: lateAssistant,
        setTerminalLifecycleMeta,
      });
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-caller-abort",
      abortSignal: controller.signal,
    });

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
    const abortedAssistant = {
      role: "assistant",
      stopReason: "aborted",
      provider: "openai",
      model: "gpt-5.5",
      content: [],
    } as unknown as NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: abortedAssistant,
        currentAttemptAssistant: abortedAssistant,
        setTerminalLifecycleMeta,
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-canonical-assistant-abort",
    });

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
          {
            role: "assistant",
            stopReason: "stop",
            provider: "openai",
            model: "gpt-5.4",
            content: [],
          } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
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
          {
            role: "assistant",
            stopReason: "stop",
            provider: "openai",
            model: "gpt-5.4",
            content: [],
          } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
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
          {
            role: "assistant",
            stopReason: "stop",
            provider: "openai",
            model: "gpt-5.4",
            content: [],
          } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
        ],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.4",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      trigger: "cron",
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-cron-no-reply-empty-final",
    });

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
        lastAssistant: {
          role: "assistant",
          stopReason: "toolUse",
          provider: "openai",
          model: "gpt-5.4",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      });
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-structured-terminal-presentation",
    });

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
        terminalPresentation: "Cron scheduler status.\nEnabled: yes",
      });
      return makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "cron" }],
        replayMetadata: {
          hadPotentialSideEffects: false,
          replaySafe: true,
        },
        lastAssistant: {
          role: "assistant",
          stopReason: "toolUse",
          provider: "openai",
          model: "gpt-5.4",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      });
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-read-only-cron-terminal-presentation",
    });

    expect(result.payloads).toEqual([
      {
        text:
          "Cron scheduler status.\nEnabled: yes\n\n" +
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
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [{ type: "text", text: "" }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      });
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [{ type: "text", text: "" }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-preserved-terminal-presentation",
    });

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
        lastAssistant: {
          role: "assistant",
          stopReason: "toolUse",
          provider: "openai",
          model: "gpt-5.4",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      });
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-stale-terminal-presentation",
    });

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
        lastAssistant: {
          role: "assistant",
          stopReason: "toolUse",
          provider: "openai",
          model: "gpt-5.4",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      });
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-side-effect-terminal-presentation",
    });

    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("couldn't generate a response");
    expect(result.meta.error?.fallbackSafe).toBe(false);
  });

  it("promotes successful final assistant text when a prompt timeout races completion", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    const finalText =
      "1. Verdict: the answer completed cleanly. 2. Evidence: the runner captured final text.";
    const finalAssistant = {
      role: "assistant",
      stopReason: "stop",
      provider: "openai",
      model: "gpt-5.5",
      content: [{ type: "text", text: finalText }],
    } as unknown as NonNullable<EmbeddedRunAttemptResult["currentAttemptAssistant"]>;
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        timedOut: true,
        lastAssistant: finalAssistant,
        currentAttemptAssistant: finalAssistant,
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-prompt-timeout-final-assistant-recovered",
    });

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
    const staleAssistant = {
      role: "assistant",
      stopReason: "stop",
      provider: "openai",
      model: "gpt-5.5",
      content: [{ type: "text", text: "Stale answer from the prior attempt." }],
    } as unknown as NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        timedOut: true,
        lastAssistant: staleAssistant,
        currentAttemptAssistant: undefined,
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-prompt-timeout-stale-assistant",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads?.some((payload) => payload.text?.includes("timed out"))).toBe(true);
    expect(result.payloads?.some((payload) => payload.text?.includes("Stale answer"))).toBe(false);
    expect(result.meta.finalAssistantVisibleText).toBeUndefined();
  });

  it("does not resolve a successful run from a stale transcript assistant", async () => {
    const staleAssistant = {
      role: "assistant",
      stopReason: "stop",
      provider: "openai",
      model: "gpt-5.5",
      content: [{ type: "text", text: "Prior transcript reply." }],
    } as unknown as NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;
    const completedAssistant = {
      role: "assistant",
      stopReason: "stop",
      provider: "openai",
      model: "gpt-5.5",
      content: [{ type: "text", text: "Current run reply." }],
    } as unknown as NonNullable<EmbeddedRunAttemptResult["currentAttemptCompletedAssistant"]>;
    mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "Current run reply." }]);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Current run reply."],
        lastAssistant: staleAssistant,
        currentAttemptAssistant: staleAssistant,
        currentAttemptCompletedAssistant: completedAssistant,
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-success-stale-transcript-assistant",
    });

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
    const completedAssistant = {
      role: "assistant",
      stopReason: "stop",
      provider: "openai",
      model: "gpt-5.5",
      content: [{ type: "text", text: "Earlier completed cycle." }],
    } as unknown as NonNullable<EmbeddedRunAttemptResult["currentAttemptCompletedAssistant"]>;
    const yieldedAssistant = {
      role: "assistant",
      stopReason: "aborted",
      provider: "openai",
      model: "gpt-5.5",
      content: [{ type: "toolCall", name: "sessions_yield", arguments: {} }],
    } as unknown as NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: yieldedAssistant,
        currentAttemptAssistant: undefined,
        currentAttemptCompletedAssistant: completedAssistant,
        yieldDetected: true,
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-yielded-assistant-classification",
    });

    expect(result.meta).toMatchObject({ livenessState: "paused", yielded: true });
    expect(mockedBuildEmbeddedRunPayloads).toHaveBeenCalledWith(
      expect.objectContaining({ currentAssistant: null, lastAssistant: yieldedAssistant }),
    );
  });

  it("recovers a completed prompt-timeout assistant without collected assistant text", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    const finalText = "Completed answer after the timeout race.";
    const finalAssistant = {
      role: "assistant",
      stopReason: "stop",
      provider: "openai",
      model: "gpt-5.5",
      content: [{ type: "text", text: finalText }],
    } as unknown as NonNullable<EmbeddedRunAttemptResult["currentAttemptAssistant"]>;
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: undefined as unknown as string[],
        timedOut: true,
        lastAssistant: finalAssistant,
        currentAttemptAssistant: finalAssistant,
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-prompt-timeout-no-assistant-texts",
    });

    expect(result.payloads).toEqual([{ text: finalText }]);
  });

  it("preserves tool media when prompt-timeout recovery replaces partial assistant text", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    const partialText = "Partial answer before the timeout race.";
    const finalText = "Complete answer after the timeout race.";
    const finalAssistant = {
      role: "assistant",
      stopReason: "stop",
      provider: "openai",
      model: "gpt-5.5",
      content: [{ type: "text", text: finalText }],
    } as unknown as NonNullable<EmbeddedRunAttemptResult["currentAttemptAssistant"]>;
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [partialText],
        timedOut: true,
        lastAssistant: finalAssistant,
        currentAttemptAssistant: finalAssistant,
        toolMediaUrls: ["https://example.test/recovered-output.png"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-prompt-timeout-final-assistant-media",
    });

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
    const finalAssistant = {
      role: "assistant",
      stopReason: "stop",
      provider: "openai",
      model: "gpt-5.5",
      content: [{ type: "text", text: finalText }],
    } as unknown as NonNullable<EmbeddedRunAttemptResult["currentAttemptAssistant"]>;
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [completedText, partialText],
        timedOut: true,
        lastAssistant: finalAssistant,
        currentAttemptAssistant: finalAssistant,
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-prompt-timeout-latest-partial",
    });

    expect(result.payloads).toEqual([{ text: completedText }, { text: finalText }]);
  });

  it("records same-model rate-limit retries without a profile-rotation trace", async () => {
    const rateLimitMessage =
      "429 rate_limit_exceeded: requests per minute exceeded; Retry-After: 30";
    const rateLimitAssistant = {
      role: "assistant",
      stopReason: "error",
      provider: "openai",
      model: "gpt-5.5",
      errorMessage: rateLimitMessage,
      content: [],
    } as unknown as NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;
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
    const recoveredAssistant = {
      role: "assistant",
      stopReason: "stop",
      provider: "openai",
      model: "gpt-5.5",
      content: [{ type: "text", text: "Recovered after a short rate-limit wait." }],
    } as unknown as NonNullable<EmbeddedRunAttemptResult["currentAttemptAssistant"]>;
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Recovered after a short rate-limit wait."],
        lastAssistant: recoveredAssistant,
        currentAttemptAssistant: recoveredAssistant,
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-same-model-rate-limit-trace",
    });

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
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_reasoning_only", type: "reasoning" }),
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      });
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Visible answer."],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [{ type: "text", text: "Visible answer." }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-reasoning-only-continuation",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    const secondCall = runAttemptCall(1);
    expect(secondCall.prompt).toBe(REASONING_ONLY_RETRY_INSTRUCTION);
    expect(secondCall.suppressNextUserMessagePersistence).toBe(false);
    expect(secondCall.skipPreparedUserTurnMessage).toBe(true);
    expectWarnMessageWith("reasoning-only assistant turn detected");
  });

  it("continues once after settled side-effecting tools finish without a final answer", async () => {
    const toolUseAssistant = {
      role: "assistant",
      stopReason: "toolUse",
      provider: "openai",
      model: "gpt-5.5",
      content: [{ type: "toolCall", id: "tool_1", name: "write", arguments: { path: "note.txt" } }],
    } as unknown as NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;
    const settledToolResults = [
      toolUseAssistant,
      { role: "toolResult", toolCallId: "tool_1", toolName: "write", isError: false },
    ] as unknown as EmbeddedRunAttemptResult["messagesSnapshot"];
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams) => {
      markUserMessagePersisted(attemptParams);
      return makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "write", meta: "path=note.txt" }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        messagesSnapshot: settledToolResults,
        lastAssistant: toolUseAssistant,
        currentAttemptAssistant: toolUseAssistant,
      });
    });
    const finalAssistant = {
      role: "assistant",
      stopReason: "stop",
      provider: "openai",
      model: "gpt-5.5",
      content: [{ type: "text", text: "Write completed. Here is the final answer." }],
    } as unknown as NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;
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

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-tool-use-terminal-continuation",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]?.text).toBe("Write completed. Here is the final answer.");
    const secondCall = runAttemptCall(1);
    expect(secondCall.prompt).toBe(SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION);
    expect(secondCall.disableTools).toBe(true);
    expect(secondCall.operation).toBe("settled-tool-finalization");
    expect(secondCall.suppressNextUserMessagePersistence).toBe(false);
    expect(secondCall.skipPreparedUserTurnMessage).toBe(true);
    expectWarnMessageWith("settled post-tool turn lacked a final answer");
  });

  it("preserves the incomplete-turn failure when the selected harness cannot finalize safely", async () => {
    registerAgentHarness({
      id: "legacy",
      label: "Legacy harness without settled-turn finalization",
      supports: () => ({ supported: true, priority: 100 }),
      runAttempt: async (params) => await mockedRunEmbeddedAttempt(params),
    });
    try {
      const toolUseAssistant = {
        role: "assistant",
        stopReason: "toolUse",
        provider: "openai",
        model: "gpt-5.5",
        content: [
          { type: "toolCall", id: "tool_1", name: "write", arguments: { path: "note.txt" } },
        ],
      } as unknown as NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;
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

      const result = await runEmbeddedAgent({
        ...overflowBaseRunParams,
        provider: "openai",
        model: "gpt-5.5",
        agentHarnessId: "legacy",
        runId: "run-tool-use-no-finalization-capability",
      });

      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
      expect(result.payloads?.[0]).toMatchObject({ isError: true });
      expect(result.payloads?.[0]?.text).toContain(
        "some tool actions may have already been executed",
      );
      expectNoWarnMessageWith("settled post-tool turn lacked a final answer");
    } finally {
      resetRunOverflowCompactionHarnessMocks();
    }
  });

  it("continues from settled side-effecting tools after an empty stop without replaying them", async () => {
    const emptyStopAssistant = {
      role: "assistant",
      stopReason: "stop",
      provider: "openai",
      model: "gpt-5.5",
      content: [],
    } as unknown as NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;
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
    const finalAssistant = {
      role: "assistant",
      stopReason: "stop",
      provider: "openai",
      model: "gpt-5.5",
      content: [{ type: "text", text: "Write completed. Here is the final answer." }],
    } as unknown as NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;
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

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      trigger: "cron",
      terminalReplyExpectation: "required",
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-empty-stop-settled-tool-continuation",
    });

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
    const emptyStopAssistant = {
      role: "assistant",
      stopReason: "stop",
      provider: "openai",
      model: "gpt-5.5",
      content: [],
    } as unknown as NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;
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

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      trigger: runPolicy.trigger,
      terminalReplyExpectation: runPolicy.terminalReplyExpectation,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-optional-empty-stop-settled-tool",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads?.[0]).toMatchObject({ isError: true });
    expectNoWarnMessageWith("settled post-tool turn lacked a final answer");
  });

  it("surfaces failure without cascading when the settled-tool continuation is also empty", async () => {
    const emptyStopAssistant = {
      role: "assistant",
      stopReason: "stop",
      provider: "openai",
      model: "gpt-5.5",
      content: [],
    } as unknown as NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;
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

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      allowEmptyAssistantReplyAsSilent: true,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-empty-stop-settled-tool-continuation-exhausted",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]).toMatchObject({ isError: true });
    expect(result.payloads?.[0]?.text).toContain(
      "some tool actions may have already been executed",
    );
    expectNoWarnMessageWith("empty response detected");
    expectWarnMessageWith("settled-turn finalization failed closed");
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
    const toolUseAssistant = {
      role: "assistant",
      stopReason: "toolUse",
      provider: "openai",
      model: "gpt-5.5",
      content: [{ type: "toolCall", id: "tool_1", name: "write", arguments: {} }],
    } as unknown as NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;
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

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-settled-finalizer-sticky-operation",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]).toMatchObject({ isError: true });
    expect(result.payloads?.[0]?.text).toContain(
      "some tool actions may have already been executed",
    );
  });

  it("surfaces the existing incomplete-turn error after one tool-use continuation", async () => {
    const toolUseAssistant = {
      role: "assistant",
      stopReason: "toolUse",
      provider: "openai",
      model: "gpt-5.5",
      content: [{ type: "toolCall", id: "tool_1", name: "write", arguments: { path: "note.txt" } }],
    } as unknown as NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;
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

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-tool-use-terminal-continuation-exhausted",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain(
      "some tool actions may have already been executed",
    );
    expectWarnMessageWith("settled-turn finalization failed closed");
  });

  it("does not claim completion for a toolUse terminal whose tools never started", async () => {
    const toolUseAssistant = {
      role: "assistant",
      stopReason: "toolUse",
      provider: "openai",
      model: "gpt-5.5",
      content: [{ type: "toolCall", id: "tool_1", name: "write", arguments: { path: "note.txt" } }],
    } as unknown as NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;
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

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-tool-use-terminal-never-started",
    });

    for (let call = 0; call < mockedRunEmbeddedAttempt.mock.calls.length; call += 1) {
      expect(runAttemptCall(call).prompt).not.toContain(
        SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION,
      );
    }
    expectNoWarnMessageWith("settled post-tool turn lacked a final answer");
  });

  it("ignores stale prior-turn tool results with colliding ids", async () => {
    const toolUseAssistant = {
      role: "assistant",
      stopReason: "toolUse",
      provider: "openai",
      model: "gpt-5.5",
      content: [{ type: "toolCall", id: "tool_1", name: "write", arguments: { path: "note.txt" } }],
    } as unknown as NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;
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

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-tool-use-terminal-stale-prior-result",
    });

    for (let call = 0; call < mockedRunEmbeddedAttempt.mock.calls.length; call += 1) {
      expect(runAttemptCall(call).prompt).not.toContain(
        SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION,
      );
    }
    expectNoWarnMessageWith("settled post-tool turn lacked a final answer");
  });

  it("does not claim completion when only part of a multi-tool request dispatched", async () => {
    const toolUseAssistant = {
      role: "assistant",
      stopReason: "toolUse",
      provider: "openai",
      model: "gpt-5.5",
      content: [
        { type: "toolCall", id: "tool_1", name: "write", arguments: { path: "a.txt" } },
        { type: "toolCall", id: "tool_2", name: "write", arguments: { path: "b.txt" } },
      ],
    } as unknown as NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;
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

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-tool-use-terminal-partial-dispatch",
    });

    for (let call = 0; call < mockedRunEmbeddedAttempt.mock.calls.length; call += 1) {
      expect(runAttemptCall(call).prompt).not.toContain(
        SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION,
      );
    }
    expectNoWarnMessageWith("settled post-tool turn lacked a final answer");
  });

  it("returns NO_REPLY without retrying reasoning-only assistant turns when silence is allowed", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.5",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_silent_group", type: "reasoning" }),
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      allowEmptyAssistantReplyAsSilent: true,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-reasoning-only-silent",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    const onlyCall = runAttemptCall(0);
    expect(onlyCall.prompt).not.toContain(REASONING_ONLY_RETRY_INSTRUCTION);
    expect(onlyCall.prompt).not.toContain(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    expectNoWarnMessageWith("reasoning-only assistant turn detected");
    expect(result.payloads).toEqual([{ text: "NO_REPLY" }]);
    expect(result.meta.terminalReplyKind).toBe("silent-empty");
    expect(result.meta.livenessState).toBe("working");
  });

  it("replays an unpersisted reasoning continuation across a missing-assistant retry", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams) => {
      markUserMessagePersisted(attemptParams);
      return makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_retry_boundary", type: "reasoning" }),
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
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

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-reasoning-continuation-missing-assistant",
    });

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
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_after_send", type: "reasoning" }),
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-reasoning-only-after-side-effects",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toBeUndefined();
  });

  it("retries reasoning-only turns when the assistant ended in error", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    const errorAssistant = {
      role: "assistant",
      stopReason: "error",
      provider: "openai",
      model: "gpt-5.4",
      errorMessage: "provider failed after emitting reasoning",
      content: [
        {
          type: "thinking",
          thinking: "internal reasoning",
          thinkingSignature: JSON.stringify({ id: "rs_error_turn", type: "reasoning" }),
        },
      ],
    } as unknown as NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;
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
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.4",
          content: [{ type: "text", text: "Recovered." }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-reasoning-only-assistant-error",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads).toBeUndefined();
  });

  it("does not retry reasoning-only turns for non-strict-agentic providers", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
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
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "anthropic",
      model: "sonnet-4.6",
      runId: "run-reasoning-only-provider-mismatch",
    });

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
        lastAssistant: {
          role: "assistant",
          api: "anthropic-messages",
          stopReason: "stop",
          provider: "kimi",
          model: "kimi-for-coding",
          content: [
            {
              type: "thinking",
              thinking: "internal Kimi reasoning",
              thinkingSignature: "",
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Visible Kimi answer."],
        lastAssistant: {
          role: "assistant",
          api: "anthropic-messages",
          stopReason: "stop",
          provider: "kimi",
          model: "kimi-for-coding",
          content: [{ type: "text", text: "Visible Kimi answer." }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "kimi",
      model: "kimi-for-coding",
      runId: "run-kimi-anthropic-reasoning-only-continuation",
    });

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
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [{ type: "text", text: "" }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      });
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Visible answer."],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [{ type: "text", text: "Visible answer." }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-empty-response-continuation",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    const secondCall = runAttemptCall(1);
    expect(secondCall.prompt).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    expect(secondCall.suppressNextUserMessagePersistence).toBe(false);
    expect(secondCall.skipPreparedUserTurnMessage).toBe(true);
    expectWarnMessageWith("empty response detected");
  });

  it("retries replay-safe missing turns despite a stale aborted transcript assistant", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    const staleAssistant = {
      role: "assistant",
      stopReason: "aborted",
      provider: "openai",
      model: "gpt-5.5",
      content: [],
    } as unknown as NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: staleAssistant,
        currentAttemptAssistant: undefined,
      }),
    );
    const recoveredAssistant = {
      role: "assistant",
      stopReason: "end_turn",
      provider: "openai",
      model: "gpt-5.5",
      content: [{ type: "text", text: "Recovered answer." }],
    } as unknown as NonNullable<EmbeddedRunAttemptResult["currentAttemptAssistant"]>;
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Recovered answer."],
        lastAssistant: recoveredAssistant,
        currentAttemptAssistant: recoveredAssistant,
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-missing-assistant-retry",
    });

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
    const recoveredAssistant = {
      role: "assistant",
      stopReason: "end_turn",
      provider: "openai",
      model: "gpt-5.5",
      content: [{ type: "text", text: "Recovered answer." }],
    } as unknown as NonNullable<EmbeddedRunAttemptResult["currentAttemptAssistant"]>;
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Recovered answer."],
        lastAssistant: recoveredAssistant,
        currentAttemptAssistant: recoveredAssistant,
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-missing-assistant-same-prompt-retry",
    });

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
    let resolvePersistApproved:
      | ((result: {
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

    const runPromise = runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-missing-assistant-delayed-persistence",
      userTurnTranscriptRecorder: {
        message: persistedMessage,
        resolveMessage: vi.fn(async () => persistedMessage),
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
    });

    await vi.waitFor(() => {
      expect(persistApproved).toHaveBeenCalledOnce();
    });
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);

    resolvePersistApproved?.({
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
    const recoveredAssistant = {
      role: "assistant",
      stopReason: "end_turn",
      provider: "openai",
      model: "gpt-5.5",
      content: [{ type: "text", text: "Recovered answer." }],
    } as unknown as NonNullable<EmbeddedRunAttemptResult["currentAttemptAssistant"]>;
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Recovered answer."],
        lastAssistant: recoveredAssistant,
        currentAttemptAssistant: recoveredAssistant,
      }),
    );

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-missing-assistant-unpersisted-retry",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(runAttemptCall(1).suppressNextUserMessagePersistence).toBe(false);
  });

  it("retries zero-token empty Claude stop turns with a visible-answer continuation instruction", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "anthropic",
          model: "claude-opus-4.7",
          content: [],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
          },
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Visible Claude answer."],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
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
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "anthropic",
      model: "claude-opus-4.7",
      runId: "run-empty-zero-usage-claude-continuation",
    });

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
        lastAssistant: {
          role: "assistant",
          api: "openai-completions",
          stopReason: "stop",
          provider: "llamacpp",
          model: "qwen3.6-27b",
          content: [],
          usage: {
            input: 512,
            output: 103,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 615,
          },
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Visible local answer."],
        lastAssistant: {
          role: "assistant",
          api: "openai-completions",
          stopReason: "stop",
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
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "llamacpp",
      model: "qwen3.6-27b",
      runId: "run-empty-openai-compatible-stop-continuation",
    });

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
        lastAssistant: {
          role: "assistant",
          api: "anthropic-messages",
          stopReason: "stop",
          provider: "sub2api",
          model: "claude-opus-4-7",
          content: [],
          usage: {
            input: 2048,
            output: 3100,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 5148,
          },
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Visible Anthropic-compatible answer."],
        lastAssistant: {
          role: "assistant",
          api: "anthropic-messages",
          stopReason: "stop",
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
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "sub2api",
      model: "claude-opus-4-7",
      runId: "run-empty-anthropic-compatible-stop-continuation",
    });

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
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [{ type: "text", text: "" }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-empty-response-exhausted",
    });

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
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
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
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      reasoningLevel: "on",
      runId: "run-reasoning-only-exhausted",
    });

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
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
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
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
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

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      reasoningLevel: "on",
      runId: "run-reasoning-terminal-presentation",
    });

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
    const toolUseAssistant = {
      role: "assistant",
      stopReason: "toolUse",
      provider: "openai",
      model: "gpt-5.5",
      content: [{ type: "tool_use", id: "tool_1", name: "bash", input: {} }],
    } as unknown as NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;
    const instruction = resolveSettledToolTerminalContinuationInstruction({
      provider: "openai",
      modelId: "gpt-5.5",
      modelApi: "openai-chatgpt-responses",
      payloadCount: 0,
      aborted,
      timedOut,
      promptError,
      attempt: makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "bash" }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        lastAssistant: toolUseAssistant,
        currentAttemptAssistant: toolUseAssistant,
      }),
    });

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
      const emptyStopAssistant = {
        role: "assistant",
        stopReason: "stop",
        provider: "openai",
        model: "gpt-5.5",
        content: [],
      } as unknown as NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;
      const instruction = resolveSettledToolTerminalContinuationInstruction({
        provider: "openai",
        modelId: "gpt-5.5",
        modelApi: "openai-chatgpt-responses",
        allowEmptyStopContinuation,
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt: makeAttemptResult({
          assistantTexts: [],
          toolMetas: [{ toolName: "write", asyncStarted, isError }],
          itemLifecycle: { startedCount, completedCount, activeCount },
          lastAssistant: emptyStopAssistant,
          currentAttemptAssistant: emptyStopAssistant,
        }),
      });

      expect(instruction).toBeNull();
    },
  );

  it("does not use a stale prior-turn empty stop to prove a settled continuation", () => {
    const staleEmptyStopAssistant = {
      role: "assistant",
      stopReason: "stop",
      provider: "openai",
      model: "gpt-5.5",
      content: [],
    } as unknown as NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;
    const instruction = resolveSettledToolTerminalContinuationInstruction({
      provider: "openai",
      modelId: "gpt-5.5",
      modelApi: "openai-chatgpt-responses",
      allowEmptyStopContinuation: true,
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "write" }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        lastAssistant: staleEmptyStopAssistant,
        currentAttemptAssistant: undefined,
      }),
    });

    expect(instruction).toBeNull();
  });

  it("does not flag stale lastAssistant=toolUse when currentAttemptAssistant=stop exists (#80918)", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 1,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["Analysis...", "Here is the final answer after update_plan."],
        toolMetas: [{ toolName: "update_plan" }],
        lastAssistant: {
          role: "assistant",
          stopReason: "toolUse",
          provider: "openai",
          model: "gpt-5.5",
          content: [
            { type: "text", text: "Analysis..." },
            { type: "tool_use", id: "tool_1", name: "update_plan", input: {} },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
        currentAttemptAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.5",
          content: [{ type: "text", text: "Here is the final answer after update_plan." }],
        } as unknown as EmbeddedRunAttemptResult["currentAttemptAssistant"],
      }),
    });

    expect(incompleteTurnText).toBeNull();
  });

  it("still flags incomplete-turn when currentAttemptAssistant is absent and lastAssistant=toolUse (#76477 regression)", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 1,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["Let me update the file..."],
        toolMetas: [{ toolName: "write" }],
        lastAssistant: {
          role: "assistant",
          stopReason: "toolUse",
          provider: "openai",
          model: "gpt-5.4",
          content: [
            { type: "text", text: "Let me update the file..." },
            { type: "tool_use", id: "tool_1", name: "write", input: {} },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
        currentAttemptAssistant: undefined,
      }),
    });

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
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 1,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["Initial analysis of the codebase..."],
        toolMetas: [{ toolName: "read", meta: "path=src/index.ts" }],
        lastAssistant: {
          role: "assistant",
          stopReason: "toolUse",
          provider: "anthropic",
          model: "sonnet-4.6",
          content: [
            { type: "text", text: "Initial analysis of the codebase..." },
            { type: "tool_use", id: "tool_1", name: "read", input: { path: "src/index.ts" } },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(incompleteTurnText).toContain("couldn't generate a response");
  });

  it("does not surface incomplete-turn error while an async media task is running", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        toolMetas: [
          {
            toolName: "image_generate",
            meta: 'generate prompt="a portrait"',
            asyncStarted: true,
          },
        ],
        lastAssistant: {
          role: "assistant",
          stopReason: "toolUse",
          provider: "openai",
          model: "gpt-5.4",
          content: [
            {
              type: "tool_use",
              id: "tool_1",
              name: "image_generate",
              input: { action: "generate", prompt: "a portrait" },
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(incompleteTurnText).toBeNull();
  });

  it("surfaces tool-use terminal with pre-tool text and side effects as replay-unsafe (#76477)", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 1,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["Let me update the file..."],
        toolMetas: [{ toolName: "write" }],
        lastAssistant: {
          role: "assistant",
          stopReason: "toolUse",
          provider: "openai",
          model: "gpt-5.4",
          content: [
            { type: "text", text: "Let me update the file..." },
            { type: "tool_use", id: "tool_1", name: "write", input: {} },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(incompleteTurnText).toContain("verify before retrying");
  });

  it("does not flag a completed tool-use turn with end_turn as incomplete (#76477)", () => {
    // When the model successfully produces post-tool text, lastAssistant has
    // stopReason=end_turn. The incomplete-turn guard should not fire.
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 1,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["Initial analysis...", "Here is the final answer."],
        toolMetas: [{ toolName: "read" }],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "anthropic",
          model: "sonnet-4.6",
          content: [{ type: "text", text: "Here is the final answer." }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(incompleteTurnText).toBeNull();
  });

  it("surfaces stall on clean stop with only an unsigned thinking payload (payloadCount=1, no visible text)", () => {
    // Regression: unsigned thinking payloads increment payloadCount but carry no
    // user-visible content. The visible-text guard must not suppress incomplete-turn
    // detection when the model produced only a thinking block and no answer. (#89787)
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 1,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "qwen3.6-35b-a3b",
          content: [
            {
              type: "thinking",
              thinking: "let me plan the tool calls I need to make...",
              // no signature — unsigned thinking block
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(incompleteTurnText).toContain("couldn't generate a response");
  });

  it("does not surface a stall when unsigned thinking accompanies visible text (payloadCount=1)", () => {
    // When the model emits both a thinking block and a visible text answer, the turn
    // succeeded and no stall should be surfaced even though thinking is unsigned.
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 1,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["Here is the answer to your question."],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "qwen3.6-35b-a3b",
          content: [
            {
              type: "thinking",
              thinking: "let me answer this...",
            },
            { type: "text", text: "Here is the answer to your question." },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

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

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "anthropic",
      model: "sonnet-4.6",
      runId: "run-tool-use-dropped-final-text",
    });

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
        lastAssistant: {
          role: "assistant",
          stopReason: "toolUse",
          provider: "openai",
          model: "gpt-5.5",
          content: [{ type: "tool_use", id: "tool_1", name: "update_plan", input: {} }],
          usage: { input: 100, output: 5, total: 105 },
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
        currentAttemptAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.5",
          content: [{ type: "text", text: finalText }],
          usage: { input: 200, output: 20, total: 220 },
        } as unknown as EmbeddedRunAttemptResult["currentAttemptAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-current-assistant-after-tool-use",
    });

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

    expect(resolveReplayInvalidFlag({ attempt })).toBe(true);
  });

  it("detects reasoning-only GPT turns from signed thinking blocks", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_helper", type: "reasoning" }),
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBe(REASONING_ONLY_RETRY_INSTRUCTION);
  });

  it("detects reasoning-only Gemini turns from signed thinking blocks", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction({
      provider: "google",
      modelId: "gemini-2.5-pro",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
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
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBe(REASONING_ONLY_RETRY_INSTRUCTION);
  });

  it("retries signed reasoning-only Bedrock Converse turns with a visible-answer continuation", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction({
      provider: "amazon-bedrock",
      modelId: "openai.gpt-oss-120b-1:0",
      modelApi: "bedrock-converse-stream",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "amazon-bedrock",
          model: "openai.gpt-oss-120b-1:0",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: "bedrock-reasoning-signature",
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBe(REASONING_ONLY_RETRY_INSTRUCTION);
  });

  it("retries signed reasoning-only Ollama turns with a visible-answer continuation instruction", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction({
      provider: "ollama",
      modelId: "gemma4:31b",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
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
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBe(REASONING_ONLY_RETRY_INSTRUCTION);
  });

  it("retries unsigned thinking-only turns via the reasoning-only path (openai-completions)", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction({
      provider: "openai",
      modelId: "qwen3.6-35b-a3b",
      modelApi: "openai-completions",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "qwen3.6-35b-a3b",
          content: [
            {
              type: "thinking",
              thinking: "let me plan the tool calls I need to make...",
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBe(REASONING_ONLY_RETRY_INSTRUCTION);
  });

  it("retries unsigned thinking-only Ollama turns via the reasoning-only path", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction({
      provider: "ollama",
      modelId: "gemma4:31b",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "ollama",
          model: "gemma4:31b",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBe(REASONING_ONLY_RETRY_INSTRUCTION);
  });

  it("retries unsigned-thinking Ollama turns via the empty-response path", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction({
      provider: "ollama",
      modelId: "gemma4:31b",
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "ollama",
          model: "gemma4:31b",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("retries generic empty Ollama turns without visible text", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction({
      provider: "ollama",
      modelId: "gemma4:31b",
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "ollama",
          model: "gemma4:31b",
          content: [{ type: "text", text: "" }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("retries empty Ollama stop turns when nonzero output tokens were generated", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction({
      provider: "ollama",
      modelId: "minimax-m2.7:cloud",
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "ollama",
          model: "minimax-m2.7:cloud",
          content: [],
          usage: { input: 100, output: 6, totalTokens: 106 },
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("does not retry empty turns after an accepted sessions_spawn delivery", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction({
      provider: "ollama",
      modelId: "gemma4:31b",
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        acceptedSessionSpawns: [
          {
            runId: "run-child",
            childSessionKey: "agent:claude:subagent:child",
          },
        ],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "ollama",
          model: "gemma4:31b",
          content: [{ type: "text", text: "" }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("retries empty openai-chatgpt-responses turns with non-zero output tokens (#85364)", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.5",
      modelApi: "openai-chatgpt-responses",
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.5",
          content: [],
          usage: { input: 24794, output: 111, cacheRead: 4608, totalTokens: 29513 },
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("retries empty openai-responses turns without visible text", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.5",
      modelApi: "openai-responses",
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.5",
          content: [],
          usage: { input: 5000, output: 200, totalTokens: 5200 },
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("retries generic empty OpenAI-compatible turns from custom endpoints", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction({
      provider: "llama-cpp-local",
      modelId: "qwen3.6-27b",
      modelApi: "openai-completions",
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "llama-cpp-local",
          model: "qwen3.6-27b",
          content: [],
          usage: { input: 950, output: 103, totalTokens: 1053 },
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("does not retry clean zero-token Ollama stop turns", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction({
      provider: "ollama",
      modelId: "glm-5.1:cloud",
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "ollama",
          model: "glm-5.1:cloud",
          content: [],
          usage: { input: 100, output: 0, totalTokens: 100 },
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("treats exact NO_REPLY as a deliberate silent assistant reply", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["NO_REPLY"],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
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
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(incompleteTurnText).toBeNull();
  });

  it("suppresses the incomplete-turn warning after committed messaging text delivery", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["Delivered through the message tool."],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "ollama",
          model: "kimi-k2.6:cloud",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(incompleteTurnText).toBeNull();
  });

  it("suppresses the incomplete-turn warning after committed messaging delivery before end_turn", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["Delivered through the message tool."],
        lastAssistant: {
          role: "assistant",
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
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(incompleteTurnText).toBeNull();
  });

  it("suppresses the incomplete-turn warning after committed media-only messaging delivery", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        didSendViaMessagingTool: false,
        messagingToolSentMediaUrls: ["file:///tmp/render.png"],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(incompleteTurnText).toBeNull();
  });

  it("suppresses the incomplete-turn warning after committed messaging delivery even when the provider errored", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["Delivered before the provider error."],
        lastAssistant: {
          role: "assistant",
          stopReason: "error",
          provider: "ollama",
          model: "kimi-k2.6:cloud",
          errorMessage: "provider failed after delivery",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

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
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        provider: "anthropic",
        model: "sonnet-4.6",
        content: [],
      } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
    };

    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult(attemptWithAcceptedSpawn),
    });

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
        lastAssistant: {
          role: "assistant",
          stopReason: "toolUse",
          provider: "openai",
          model: "gpt-5.4",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-timeout-after-accepted-spawn",
    });

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
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        provider: "anthropic",
        model: "sonnet-4.6",
        content: [],
      } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
    };

    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult(attemptWithMalformedSpawn),
    });

    expect(incompleteTurnText).toContain("couldn't generate a response");
  });

  it("still surfaces the incomplete-turn warning when no messaging delivery was committed", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        didSendViaMessagingTool: true,
        lastAssistant: {
          role: "assistant",
          stopReason: "error",
          provider: "ollama",
          model: "kimi-k2.6:cloud",
          errorMessage: "provider failed mid-turn",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

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

  it("treats committed messaging text as replay-invalid side effect metadata", () => {
    expect(
      buildAttemptReplayMetadata({
        toolMetas: [],
        didSendViaMessagingTool: false,
        messagingToolSentTexts: ["Delivered through the message tool."],
        messagingToolSentMediaUrls: [],
      }),
    ).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
  });

  it("treats async-started background tools as replay-invalid side effects", () => {
    expect(
      buildAttemptReplayMetadata({
        toolMetas: [{ toolName: "image_generate", asyncStarted: true }],
        didSendViaMessagingTool: false,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
      }),
    ).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
  });

  it("treats committed messaging media as replay-invalid side effect metadata", () => {
    expect(
      buildAttemptReplayMetadata({
        toolMetas: [],
        didSendViaMessagingTool: false,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: ["file:///tmp/render.png"],
      }),
    ).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
  });

  it("treats committed messaging targets as replay-invalid side effect metadata", () => {
    expect(
      buildAttemptReplayMetadata({
        toolMetas: [],
        didSendViaMessagingTool: false,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [{ tool: "message", provider: "slack", to: "channel-1" }],
      }),
    ).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
  });

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
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["Delivered through the message tool."],
        lastToolError: {
          toolName: "message",
          meta: "send",
          error: "delivery failed for second target",
        },
        lastAssistant: {
          role: "assistant",
          stopReason: "error",
          provider: "openai",
          model: "gpt-5.4",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(incompleteTurnText).toBeNull();
  });

  it("does not retry reasoning-only GPT turns after side effects", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        didSendViaMessagingTool: true,
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_side_effect", type: "reasoning" }),
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBeNull();
    expect(DEFAULT_REASONING_ONLY_RETRY_LIMIT).toBe(2);
  });

  it("does not retry reasoning-only GPT turns when the assistant ended in error", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "error",
          provider: "openai",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_helper_error", type: "reasoning" }),
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("does not retry reasoning-only GPT turns when visible assistant text already exists", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["Visible answer."],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
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
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("surfaces incomplete-turn text for errored signed-thinking-only turns with payloads", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 1,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
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
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(incompleteTurnText).toContain("couldn't generate a response");
  });

  it("surfaces incomplete-turn text for token-limited partial answers", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 1,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["Partial answer"],
        lastAssistant: {
          role: "assistant",
          stopReason: "length",
          provider: "ollama",
          model: "qwen3.5",
          content: [{ type: "text", text: "Partial answer" }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(incompleteTurnText).toContain("couldn't generate a response");
  });

  it("keeps complete visible stop turns successful", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 1,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["Complete answer"],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "ollama",
          model: "qwen3.5",
          content: [{ type: "text", text: "Complete answer" }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(incompleteTurnText).toBeNull();
  });

  it("preserves terminal tool media on token-limited turns", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 1,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["Partial answer"],
        toolMediaUrls: ["file:///tmp/render.png"],
        lastAssistant: {
          role: "assistant",
          stopReason: "length",
          provider: "ollama",
          model: "qwen3.5",
          content: [{ type: "text", text: "Partial answer" }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(incompleteTurnText).toBeNull();
  });

  it("preserves tool media already delivered through block replies", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 1,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["Partial answer"],
        hasToolMediaBlockReply: true,
        lastAssistant: {
          role: "assistant",
          stopReason: "length",
          provider: "ollama",
          model: "qwen3.5",
          content: [{ type: "text", text: "Partial answer" }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(incompleteTurnText).toBeNull();
  });

  it("preserves successful cron progress on token-limited turns", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 1,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["Partial answer"],
        successfulCronAdds: 1,
        lastAssistant: {
          role: "assistant",
          stopReason: "length",
          provider: "ollama",
          model: "qwen3.5",
          content: [{ type: "text", text: "Partial answer" }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

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
      const incompleteTurnText = resolveIncompleteTurnPayloadText({
        payloadCount: 1,
        aborted: false,
        timedOut: false,
        attempt: makeAttemptResult({
          assistantTexts: [],
          ...attemptState,
          lastAssistant: {
            role: "assistant",
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
          } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
        }),
      });

      expect(incompleteTurnText).toBeNull();
    },
  );

  it("retries replay-safe errored turns that only emitted thinking blocks", () => {
    const assistant = {
      role: "assistant",
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
    } as unknown as EmbeddedRunAttemptResult["lastAssistant"];
    expect(
      shouldRetrySilentErrorAssistantTurn({
        attempt: makeAttemptResult({ assistantTexts: [], lastAssistant: assistant }),
        assistant,
      }),
    ).toBe(true);
  });

  it("does not retry errored empty turns when non-zero output may indicate progress", () => {
    const assistant = {
      role: "assistant",
      stopReason: "error",
      provider: "ollama",
      model: "glm-5.1:cloud",
      content: [],
      usage: { input: 100, output: 12, totalTokens: 112 },
    } as unknown as EmbeddedRunAttemptResult["lastAssistant"];
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
    const assistant = {
      role: "assistant",
      stopReason: "error",
      provider: "anthropic",
      model: "claude-opus-4-8",
      content,
      usage: { input: 100, output: 1120, totalTokens: 1220 },
    } as unknown as EmbeddedRunAttemptResult["lastAssistant"];
    expect(
      shouldRetrySilentErrorAssistantTurn({
        attempt: makeAttemptResult({ assistantTexts: [], lastAssistant: assistant }),
        assistant,
      }),
    ).toBe(false);
  });

  it("does not retry errored thinking-only turns after side effects", () => {
    const assistant = {
      role: "assistant",
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
    } as unknown as EmbeddedRunAttemptResult["lastAssistant"];
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
      const assistant = {
        role: "assistant",
        stopReason: "error",
        provider: "openrouter",
        model: "test-model",
        content: [],
        usage: { input: 100, output: 0, totalTokens: 100 },
      } as unknown as EmbeddedRunAttemptResult["lastAssistant"];
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
    const retryInstruction = resolveEmptyResponseRetryInstruction({
      provider: "llamacpp",
      modelId: "qwen3.6-27b",
      modelApi: "openai-completions",
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "llamacpp",
          model: "qwen3.6-27b",
          content: [],
          usage: { input: 512, output: 103, totalTokens: 615 },
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("detects generic empty GPT turns without visible text", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [{ type: "text", text: "" }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    expect(DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT).toBe(1);
  });

  it("surfaces empty Codex app-server replies after successful sparse bash output", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "bash", meta: "exit=0" }],
        messagesSnapshot: [
          {
            role: "toolResult",
            content: [{ type: "text", text: "" }],
            details: { aggregated: "" },
          } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
          {
            role: "assistant",
            stopReason: "stop",
            provider: "openai",
            model: "gpt-5.5",
            content: [{ type: "text", text: "" }],
          } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
        ],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.5",
          content: [{ type: "text", text: "" }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(incompleteTurnText).toContain("couldn't generate a response");
    expect(incompleteTurnText).toContain("verify before retrying");
  });

  it("retries generic empty Bedrock Converse turns without visible text", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction({
      provider: "amazon-bedrock",
      modelId: "openai.gpt-oss-120b-1:0",
      modelApi: "bedrock-converse-stream",
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "amazon-bedrock",
          model: "openai.gpt-oss-120b-1:0",
          content: [{ type: "text", text: "" }],
          usage: { input: 950, output: 103, totalTokens: 1053 },
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("treats clean empty assistant turns as silent only when the caller allows it", () => {
    const attempt = makeAttemptResult({
      assistantTexts: [],
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        provider: "openai",
        model: "gpt-5.5",
        content: [{ type: "text", text: "" }],
      } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
    });

    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        allowEmptyAssistantReplyAsSilent: true,
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt,
      }),
    ).toBe(true);
    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        allowEmptyAssistantReplyAsSilent: false,
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt,
      }),
    ).toBe(false);
  });

  it("treats reasoning-only assistant turns as silent only when the caller allows it", () => {
    const attempt = makeAttemptResult({
      assistantTexts: [],
      lastAssistant: {
        role: "assistant",
        stopReason: "end_turn",
        provider: "openai",
        model: "gpt-5.5",
        content: [
          {
            type: "thinking",
            thinking: "internal reasoning",
            thinkingSignature: JSON.stringify({ id: "rs_silent_helper", type: "reasoning" }),
          },
        ],
      } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
    });

    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        allowEmptyAssistantReplyAsSilent: true,
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt,
      }),
    ).toBe(true);
    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        allowEmptyAssistantReplyAsSilent: false,
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt,
      }),
    ).toBe(false);
  });

  it("treats exact NO_REPLY assistant turns as silent only when the caller allows it", () => {
    const attempt = makeAttemptResult({
      assistantTexts: ["NO_REPLY"],
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        provider: "openai",
        model: "gpt-5.5",
        content: [{ type: "text", text: "NO_REPLY" }],
      } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
    });

    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        allowEmptyAssistantReplyAsSilent: true,
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt,
      }),
    ).toBe(true);
    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        allowEmptyAssistantReplyAsSilent: false,
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt,
      }),
    ).toBe(false);
  });

  it("treats post-tool exact NO_REPLY assistant turns as intentional silence", () => {
    const attempt = makeAttemptResult({
      assistantTexts: ["NO_REPLY"],
      toolMetas: [{ toolName: "process.poll", meta: "pid=123", replaySafe: true }],
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        provider: "openai",
        model: "gpt-5.5",
        content: [{ type: "text", text: "NO_REPLY" }],
      } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
    });

    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        allowEmptyAssistantReplyAsSilent: true,
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt,
      }),
    ).toBe(true);
  });

  it("does not treat error or side-effect empty turns as silent", () => {
    const errorAttempt = makeAttemptResult({
      assistantTexts: [],
      lastAssistant: {
        role: "assistant",
        stopReason: "error",
        provider: "openai",
        model: "gpt-5.5",
        content: [],
      } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
    });
    const silentErrorAttempt = makeAttemptResult({
      assistantTexts: ["NO_REPLY"],
      lastAssistant: {
        role: "assistant",
        stopReason: "error",
        provider: "openai",
        model: "gpt-5.5",
        content: [{ type: "text", text: "NO_REPLY" }],
      } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
    });
    const sideEffectAttempt = makeAttemptResult({
      assistantTexts: [],
      didSendViaMessagingTool: true,
      messagingToolSentTexts: ["sent already"],
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        provider: "openai",
        model: "gpt-5.5",
        content: [{ type: "text", text: "" }],
      } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
    });
    const postToolEmptyAttempt = makeAttemptResult({
      assistantTexts: [],
      toolMetas: [{ toolName: "process.poll", meta: "pid=123", replaySafe: true }],
      lastAssistant: {
        role: "assistant",
        api: "openai-completions",
        stopReason: "stop",
        provider: "stepfun",
        model: "step-router-v1",
        content: [],
      } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
    });

    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        allowEmptyAssistantReplyAsSilent: true,
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt: errorAttempt,
      }),
    ).toBe(false);
    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        allowEmptyAssistantReplyAsSilent: true,
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt: silentErrorAttempt,
      }),
    ).toBe(false);
    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        allowEmptyAssistantReplyAsSilent: true,
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt: sideEffectAttempt,
      }),
    ).toBe(false);
    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        allowEmptyAssistantReplyAsSilent: true,
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt: postToolEmptyAttempt,
      }),
    ).toBe(false);
  });

  it("returns NO_REPLY without retrying clean empty assistant turns when silence is allowed", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.5",
          content: [{ type: "text", text: "" }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      allowEmptyAssistantReplyAsSilent: true,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-empty-assistant-silent",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    const onlyCall = runAttemptCall(0);
    expect(onlyCall.prompt).not.toContain(REASONING_ONLY_RETRY_INSTRUCTION);
    expect(onlyCall.prompt).not.toContain(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    expect(result.payloads).toEqual([{ text: "NO_REPLY" }]);
    expect(result.meta.terminalReplyKind).toBe("silent-empty");
    expect(result.meta.livenessState).toBe("working");
  });

  it("returns NO_REPLY without retrying exact silent assistant replies when silence is allowed", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: ["NO_REPLY"],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.5",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_exact_silent", type: "reasoning" }),
            },
            { type: "text", text: "NO_REPLY" },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      allowEmptyAssistantReplyAsSilent: true,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-exact-silent-assistant-reply",
    });

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
        lastAssistant: {
          role: "assistant",
          api: "openai-completions",
          stopReason: "stop",
          provider: "stepfun",
          model: "step-router-v1",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
        currentAttemptAssistant: {
          role: "assistant",
          api: "openai-completions",
          stopReason: "stop",
          provider: "stepfun",
          model: "step-router-v1",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["currentAttemptAssistant"],
      }),
    );
    const finalAssistant = {
      role: "assistant",
      api: "openai-completions",
      stopReason: "stop",
      provider: "stepfun",
      model: "step-router-v1",
      content: [{ type: "text", text: "Visible StepFun answer." }],
    } as unknown as NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Visible StepFun answer."],
        lastAssistant: finalAssistant,
        currentAttemptAssistant: finalAssistant,
        currentAttemptCompletedAssistant: finalAssistant,
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      allowEmptyAssistantReplyAsSilent: true,
      provider: "stepfun",
      model: "step-router-v1",
      runId: "run-post-tool-openai-compatible-empty-stop",
    });

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
        lastAssistant: {
          role: "assistant",
          api: "openai-completions",
          stopReason: "stop",
          provider: "stepfun",
          model: "step-router-v1",
          content: [{ type: "text", text: "NO_REPLY" }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      allowEmptyAssistantReplyAsSilent: true,
      provider: "stepfun",
      model: "step-router-v1",
      runId: "run-post-tool-exact-silent-retry",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    const onlyCall = runAttemptCall(0);
    expect(onlyCall.prompt).not.toContain(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    expectNoWarnMessageWith("empty response detected");
    expectNoWarnMessageWith("incomplete turn detected");
    expect(result.payloads).toEqual([{ text: "NO_REPLY" }]);
    expect(result.meta.terminalReplyKind).toBe("silent-empty");
    expect(result.meta.livenessState).toBe("working");
  });

  it("keeps retrying and surfacing clean empty assistant turns without the silence flag", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.4",
          content: [{ type: "text", text: "" }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-empty-assistant-error",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("couldn't generate a response");
  });

  it("detects generic empty Gemini turns without visible text", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction({
      provider: "google-vertex",
      modelId: "google/gemini-3.1-flash",
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "google-vertex",
          model: "gemini-3.1-flash",
          content: [{ type: "text", text: "" }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("does not retry generic empty GPT turns after side effects", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        didSendViaMessagingTool: true,
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [{ type: "text", text: "" }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

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

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      prompt:
        "made a bunch of improvements to the student's source code (openclaw) this weekend, along with a few other maintainers. hopefully he will be more proactive now",
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-visible-prose-no-classifier",
      config: {
        agents: {
          list: [{ id: "main" }],
        },
      } as OpenClawConfig,
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toBeUndefined();
    expect(result.meta.livenessState).toBe("working");
    expectNoWarnMessageWith("planning");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
