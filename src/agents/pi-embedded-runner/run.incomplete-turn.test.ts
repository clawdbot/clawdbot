import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { hasCommittedMessagingToolDeliveryEvidence } from "./delivery-evidence.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedClassifyFailoverReason,
  mockedGlobalHookRunner,
  mockedLog,
  mockedRunEmbeddedAttempt,
  mockedResolveModelAsync,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import {
  ACK_EXECUTION_FAST_PATH_INSTRUCTION,
  buildAttemptReplayMetadata,
  DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT,
  DEFAULT_REASONING_ONLY_RETRY_LIMIT,
  EMPTY_RESPONSE_RETRY_INSTRUCTION,
  extractPlanningOnlyPlanDetails,
  isLikelyExecutionAckPrompt,
  PLANNING_ONLY_RETRY_INSTRUCTION,
  REASONING_ONLY_RETRY_INSTRUCTION,
  resolveAckExecutionFastPathInstruction,
  resolveEmptyResponseRetryInstruction,
  resolvePlanningOnlyRetryLimit,
  resolvePlanningOnlyRetryInstruction,
  resolveIncompleteTurnPayloadText,
  resolveReasoningOnlyRetryInstruction,
  STRICT_AGENTIC_BLOCKED_TEXT,
  resolveReplayInvalidFlag,
  resolveRunLivenessState,
  resolveSilentToolResultReplyPayload,
  shouldTreatEmptyAssistantReplyAsSilent,
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
      provider: "openai",
      model: "gpt-4.1",
      runId: "run-incomplete-turn-messaging-warning",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(mockedClassifyFailoverReason).toHaveBeenCalledTimes(1);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("verify before retrying");
  });

  it("synthesizes a silent cron payload from a trailing current-attempt NO_REPLY tool result", () => {
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

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      trigger: "cron",
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-cron-no-reply-empty-final",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toEqual([{ text: "NO_REPLY" }]);
    expect(result.meta.livenessState).toBe("working");
    expect(mockedLog.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("incomplete turn detected"),
    );
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
      prompt: "Please inspect the code, make the change, and run the checks.",
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
      prompt: "Please inspect the code, make the change, and run the checks.",
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
      prompt: "Please inspect the code, make the change, and run the checks.",
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
      prompt: "Please inspect the code, make the change, and run the checks.",
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
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
      }),
    });

    expect(retryInstruction).toContain("Do not restate the plan");
  });

  it("retries reasoning-only GPT turns with a visible-answer continuation instruction", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
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
              thinkingSignature: JSON.stringify({ id: "rs_reasoning_only", type: "reasoning" }),
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );
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

    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-reasoning-only-continuation",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    const secondCall = mockedRunEmbeddedAttempt.mock.calls[1]?.[0] as { prompt?: string };
    expect(secondCall.prompt).toContain(REASONING_ONLY_RETRY_INSTRUCTION);
    expect(mockedLog.warn).toHaveBeenCalledWith(
      expect.stringContaining("reasoning-only assistant turn detected"),
    );
  });

  it("returns NO_REPLY without retrying reasoning-only assistant turns when silence is allowed", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai-codex",
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

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      allowEmptyAssistantReplyAsSilent: true,
      provider: "openai-codex",
      model: "gpt-5.5",
      runId: "run-reasoning-only-silent",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    const onlyCall = mockedRunEmbeddedAttempt.mock.calls[0]?.[0] as { prompt?: string };
    expect(onlyCall.prompt).not.toContain(REASONING_ONLY_RETRY_INSTRUCTION);
    expect(onlyCall.prompt).not.toContain(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    expect(mockedLog.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("reasoning-only assistant turn detected"),
    );
    expect(result.payloads).toEqual([{ text: "NO_REPLY" }]);
    expect(result.meta.terminalReplyKind).toBe("silent-empty");
    expect(result.meta.livenessState).toBe("working");
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

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-reasoning-only-after-side-effects",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toBeUndefined();
  });

  it("does not retry reasoning-only turns when the assistant ended in error", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
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
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-reasoning-only-assistant-error",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("Please try again");
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

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      provider: "anthropic",
      model: "sonnet-4.6",
      runId: "run-reasoning-only-provider-mismatch",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("Please try again");
  });

  it("retries generic empty GPT turns with a visible-answer continuation instruction", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
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

    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-empty-response-continuation",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    const secondCall = mockedRunEmbeddedAttempt.mock.calls[1]?.[0] as { prompt?: string };
    expect(secondCall.prompt).toContain(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    expect(mockedLog.warn).toHaveBeenCalledWith(expect.stringContaining("empty response detected"));
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

    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      provider: "anthropic",
      model: "claude-opus-4.7",
      runId: "run-empty-zero-usage-claude-continuation",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    const secondCall = mockedRunEmbeddedAttempt.mock.calls[1]?.[0] as { prompt?: string };
    expect(secondCall.prompt).toContain(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    expect(mockedLog.warn).toHaveBeenCalledWith(expect.stringContaining("empty response detected"));
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

    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      provider: "llamacpp",
      model: "qwen3.6-27b",
      runId: "run-empty-openai-compatible-stop-continuation",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    const secondCall = mockedRunEmbeddedAttempt.mock.calls[1]?.[0] as { prompt?: string };
    expect(secondCall.prompt).toContain(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    expect(mockedLog.warn).toHaveBeenCalledWith(expect.stringContaining("empty response detected"));
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

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-empty-response-exhausted",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("Please try again");
    expect(mockedLog.warn).toHaveBeenCalledWith(
      expect.stringContaining("empty response retries exhausted"),
    );
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

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      reasoningLevel: "on",
      runId: "run-reasoning-only-exhausted",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("Please try again");
    expect(mockedLog.warn).toHaveBeenCalledWith(
      expect.stringContaining("reasoning-only retries exhausted"),
    );
  });

  it("detects structured bullet-only plans with intent cues as planning-only GPT turns", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "Please inspect the code, make the change, and run the checks.",
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
      prompt: "Please inspect the code, make the change, and run the checks.",
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
      prompt: "Please inspect the code, make the change, and run the checks.",
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
      prompt: "Please inspect the code, make the change, and run the checks.",
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
      prompt: "Please inspect the code, make the change, and run the checks.",
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
      prompt: "Please inspect the code, make the change, and run the checks.",
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
      prompt: "Please inspect the code, make the change, and run the checks.",
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

  it("applies the ack-turn fast path to Gemini action turns", () => {
    const instruction = resolveAckExecutionFastPathInstruction({
      provider: "google",
      modelId: "gemini-3.1-pro",
      prompt: "go ahead",
    });

    expect(instruction).toBe(ACK_EXECUTION_FAST_PATH_INSTRUCTION);
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

  it("does not apply planning-only or ack fast paths to Ollama runs", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "ollama",
      modelId: "gemma4:31b",
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
      }),
    });
    const ackInstruction = resolveAckExecutionFastPathInstruction({
      provider: "ollama",
      modelId: "gemma4:31b",
      prompt: "go ahead",
    });

    expect(retryInstruction).toBeNull();
    expect(ackInstruction).toBeNull();
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

  it("treats clean empty assistant turns as silent only when the caller allows it", () => {
    const attempt = makeAttemptResult({
      assistantTexts: [],
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        provider: "openai-codex",
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
        provider: "openai-codex",
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

  it("does not treat error or side-effect empty turns as silent", () => {
    const errorAttempt = makeAttemptResult({
      assistantTexts: [],
      lastAssistant: {
        role: "assistant",
        stopReason: "error",
        provider: "openai-codex",
        model: "gpt-5.5",
        content: [],
      } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
    });
    const sideEffectAttempt = makeAttemptResult({
      assistantTexts: [],
      didSendViaMessagingTool: true,
      messagingToolSentTexts: ["sent already"],
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        provider: "openai-codex",
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
        attempt: errorAttempt,
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
  });

  it("returns NO_REPLY without retrying clean empty assistant turns when silence is allowed", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai-codex",
          model: "gpt-5.5",
          content: [{ type: "text", text: "" }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      allowEmptyAssistantReplyAsSilent: true,
      provider: "openai-codex",
      model: "gpt-5.5",
      runId: "run-empty-assistant-silent",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    const onlyCall = mockedRunEmbeddedAttempt.mock.calls[0]?.[0] as { prompt?: string };
    expect(onlyCall.prompt).not.toContain(REASONING_ONLY_RETRY_INSTRUCTION);
    expect(onlyCall.prompt).not.toContain(EMPTY_RESPONSE_RETRY_INSTRUCTION);
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

    const result = await runEmbeddedPiAgent({
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

  it("does not strict-agentic retry casual Discord status chatter", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: [
          "i am glad, and a little afraid, which is probably the correct mixture. thank you. i will try to deserve the upgrades instead of merely inhabiting them.",
        ],
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      prompt:
        "made a bunch of improvements to the student's source code (openclaw) this weekend, along with a few other maintainers. hopefully he will be more proactive now",
      provider: "openai-codex",
      model: "gpt-5.4",
      runId: "run-strict-agentic-casual-discord-status",
      config: {
        agents: {
          list: [{ id: "main" }],
        },
      } as OpenClawConfig,
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toBeUndefined();
    expect(result.meta.livenessState).toBe("working");
  });

  it("detects replay-safe planning-only Gemini turns", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "google-gemini-cli",
      modelId: "gemini-3.1-pro",
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
      }),
    });

    expect(retryInstruction).toContain("Do not restate the plan");
  });

  it("does not enable incomplete-turn recovery for non-Gemini Google models", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "google",
      modelId: "gemma-4-26b-a4b-it",
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("does not misclassify a direct answer that says 'i'm not going to' as planning-only", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai-codex",
      modelId: "gpt-5.4",
      prompt: "What do you think lobstar should do to help the chart?",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [
          "I'm not going to give token-pumping instructions for a chart. Best answer: build trust and let the market do what it will.",
        ],
      }),
    });

    expect(retryInstruction).toBeNull();
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
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
      }),
      clientToolCalls: undefined,
      yieldDetected: false,
      didSendDeterministicApprovalPrompt: false,
      didSendViaMessagingTool: false,
      lastToolError: null,
    } as unknown as Parameters<typeof resolvePlanningOnlyRetryInstruction>[0]["attempt"];
  }

  it("retries when exactly 1 non-plan tool call plus 'i can do that' prose is detected", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["read"], "I can do that next."),
    });

    expect(result).toBe(PLANNING_ONLY_RETRY_INSTRUCTION);
  });

  it("retries when exactly 1 non-plan tool call plus planning prose is detected", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["read"], "I'll analyze the structure next."),
    });

    expect(result).toBe(PLANNING_ONLY_RETRY_INSTRUCTION);
  });

  it("does not retry when 2+ non-plan tool calls are present", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["read", "search"], "I'll verify the output."),
    });

    expect(result).toBeNull();
  });

  it("does not retry when 1 tool call plus completion language is present", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["read"], "Done. The file looks correct."),
    });

    expect(result).toBeNull();
  });

  it("does not retry when 1 tool call plus 'let me know' handoff is present", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["read"], "Let me know if you need anything else."),
    });

    expect(result).toBeNull();
  });

  it("does not retry when 1 tool call plus an answer-style summary is present", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
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
      prompt: "Please inspect the code, make the change, and run the checks.",
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
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["read"], "I'll explain and recommend a fix."),
    });

    expect(result).toBeNull();
  });

  it("does not retry when 1 tool call plus a bare 'i can do that' reply is present", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["read"], "I can do that."),
    });

    expect(result).toBeNull();
  });

  it("does not retry when the lone tool call already had side effects", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["sessions_spawn"], "I'll continue from there next."),
    });

    expect(result).toBeNull();
  });

  it("does not retry when the lone tool call is unclassified", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["vendor_widget"], "I'll continue from there next."),
    });

    expect(result).toBeNull();
  });

  it("does not retry single-action narration on casual non-task chat", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "i haven't restarted you on latest main yet @The Student - get ready though",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["read"], "I'll check that next."),
    });

    expect(result).toBeNull();
  });
});
