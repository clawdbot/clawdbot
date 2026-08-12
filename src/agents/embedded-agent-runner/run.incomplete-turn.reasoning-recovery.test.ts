// Focused incomplete-turn behavior coverage.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  REASONING_ONLY_RETRY_INSTRUCTION,
  EMPTY_RESPONSE_RETRY_INSTRUCTION,
  runEmbeddedAgent,
  makeLastAssistant,
  makeRunParams,
  expectWarnMessageWith,
  expectNoWarnMessageWith,
  runAttemptCall,
  markUserMessagePersisted,
} from "./run.incomplete-turn.test-helpers.js";
import {
  mockedClassifyFailoverReason,
  mockedRunEmbeddedAttempt,
  mockedResolveModelAsync,
  overflowBaseRunParams,
  resetRunIncompleteTurnOwnerMocks,
} from "./run.incomplete-turn.test-support.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";

describe("runEmbeddedAgent incomplete-turn safety", () => {
  beforeEach(() => {
    resetRunIncompleteTurnOwnerMocks();
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
});
