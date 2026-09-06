import { beforeEach, describe, expect, it, vi } from "vitest";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import { classifyAgentExecResult } from "../../../commands/agent-exec-result.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  markEmbeddedRunAuthProfileSuccess,
  reportEmbeddedRunSuccessfulAuthBinding,
} from "./auth-profile-success.js";
import { TRUNCATED_REPLY_NOTICE_TEXT } from "./incomplete-turn-resolution.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./terminal-outcome.js";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import {
  emptyAssistant,
  makeTerminalInput,
  resolveTerminalText,
  type TerminalInput,
} from "./terminal-resolution.test-support.js";
import { createEmbeddedRunTerminalRetryState } from "./terminal-retry-state.js";

vi.mock("./auth-profile-success.js", () => ({
  markEmbeddedRunAuthProfileSuccess: vi.fn(),
  reportEmbeddedRunSuccessfulAuthBinding: vi.fn(),
}));

const EMPTY_RESPONSE_RETRY_INSTRUCTION =
  "The previous attempt did not produce a user-visible answer. Continue from the current state and produce the visible answer now. Do not restart from scratch.";
const REASONING_ONLY_RETRY_INSTRUCTION =
  "The previous assistant turn recorded reasoning but did not produce a user-visible answer. Continue from that partial turn and produce the visible answer now. Do not restate the reasoning or restart from scratch.";

describe("terminal resolution", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([false, true])(
    "resolves an empty post-tool turn using committed media delivery (delivered: %s)",
    async (hasToolMediaBlockReply) => {
      const assistant = emptyAssistant();
      const attempt = makeEmbeddedRunnerAttempt({
        assistantTexts: [],
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
        toolMetas: [{ toolName: "tts", isError: false, replaySafe: false }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        hasToolMediaBlockReply,
      });
      const input = makeTerminalInput({ attempt });

      const resolved = await resolveEmbeddedRunTerminal(input);

      expect(resolved.action).toBe("complete");
      expect(input.activateInternalPrompt).not.toHaveBeenCalled();
      if (resolved.action !== "complete") {
        throw new Error("expected terminal resolution to complete");
      }
      if (hasToolMediaBlockReply) {
        expect(resolved.result.meta.error).toBeUndefined();
        expect(resolved.result.payloads ?? []).toEqual([]);
      } else {
        expect(resolved.result.meta.error?.kind).toBe("incomplete_turn");
        expect(resolved.result.payloads).toEqual([
          expect.objectContaining({ isError: true, text: expect.any(String) }),
        ]);
      }
    },
  );

  it.each(["empty", "reasoning", "cleanup", "tool warning", "partial reply", "committed delivery"])(
    "preserves a failed harness turn instead of retrying its %s output",
    async (output) => {
      const error = new Error("Provider failed while a tool was pending");
      const cleanupFailed = output !== "empty" && output !== "reasoning";
      const partialText = "The first operation finished.";
      const assistant =
        output === "reasoning"
          ? buildEmbeddedRunnerAssistant({ content: [{ type: "thinking", thinking: "checking" }] })
          : cleanupFailed
            ? buildEmbeddedRunnerAssistant({
                stopReason: "toolUse",
                content: [{ type: "text", text: partialText }],
              })
            : undefined;
      const payloads =
        output === "tool warning"
          ? [{ text: "The pending tool was cancelled.", isError: true }]
          : output === "partial reply"
            ? [{ text: partialText }]
            : output === "cleanup"
              ? undefined
              : [];
      const attempt = makeEmbeddedRunnerAttempt({
        terminal: { kind: "failed", source: "prompt", error },
        assistantTexts: output === "partial reply" ? [partialText] : [],
        currentAttemptAssistant: assistant,
        lastAssistant: assistant,
        lastToolError: cleanupFailed
          ? { toolName: "exec", error: "Tool execution aborted" }
          : undefined,
        toolMetas: cleanupFailed ? [{ toolName: "exec", isError: true, replaySafe: false }] : [],
        didSendViaMessagingTool: output === "committed delivery",
        messagingToolSentTexts: output === "committed delivery" ? [partialText] : [],
        replayMetadata: { hadPotentialSideEffects: cleanupFailed, replaySafe: false },
      });
      const onSuccessfulAuthProfile = vi.fn();
      const input = makeTerminalInput({
        attempt,
        payloadsWithToolMedia: payloads,
        authProfileId: "openai:selected",
        runParams: { onSuccessfulAuthProfile },
      });

      const resolved = await resolveEmbeddedRunTerminal(input);

      expect(resolved).toMatchObject({
        action: "complete",
        result: { meta: { error: { message: error.message, fallbackSafe: false } } },
      });
      expect(input.activateInternalPrompt).not.toHaveBeenCalled();
      expect(input.setSuppressNextUserMessagePersistence).not.toHaveBeenCalled();
      expect(input.armPostCompactionGuard).not.toHaveBeenCalled();
      expect(markEmbeddedRunAuthProfileSuccess).not.toHaveBeenCalled();
      expect(reportEmbeddedRunSuccessfulAuthBinding).not.toHaveBeenCalled();
      expect(onSuccessfulAuthProfile).not.toHaveBeenCalled();
      expect(input.setTerminalLifecycleMeta).toHaveBeenCalledWith(
        expect.objectContaining({ livenessState: "abandoned" }),
      );
      if (resolved.action === "complete") {
        expect(classifyAgentExecResult(resolved.result).status).toBe("error");
        expect(resolved.result.meta.executionTrace?.attempts ?? []).not.toContainEqual(
          expect.objectContaining({ result: "success" }),
        );
        if (cleanupFailed) {
          expect(resolved.result.payloads ?? []).toEqual(payloads ?? []);
          expect(resolved.result.messagingToolSentTexts).toEqual(attempt.messagingToolSentTexts);
        }
      }
    },
  );

  it("keeps external cancellation ahead of a failed attempt during final result construction", async () => {
    const assistant = emptyAssistant({ stopReason: "stop" });
    const attempt = makeEmbeddedRunnerAttempt({
      terminal: { kind: "failed", source: "prompt", error: new Error("Late provider failure") },
      lastToolError: { toolName: "exec", error: "Tool execution aborted" },
      currentAttemptAssistant: assistant,
      replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    });
    const terminalState = resolveEmbeddedRunAttemptTerminalState({
      attempt,
      assistant,
      abortSignal: AbortSignal.abort(),
    });
    const input = makeTerminalInput({ attempt, terminalState });
    const resolved = await resolveEmbeddedRunTerminal(input);
    expect(resolved).toMatchObject({ action: "complete", result: { meta: { aborted: true } } });
    if (resolved.action === "complete") {
      expect(resolved.result.meta.error).toBeUndefined();
      expect(resolved.result.meta.livenessState).toBe("blocked");
    }
    expect(input.activateInternalPrompt).not.toHaveBeenCalled();
  });

  it("keeps an ordinary tool failure nonfatal when the attempt completed", async () => {
    const text = "The operation failed; the earlier result is still available.";
    const assistant = buildEmbeddedRunnerAssistant({ content: [{ type: "text", text }] });
    const attempt = makeEmbeddedRunnerAttempt({
      lastToolError: { toolName: "exec", error: "Tool failed" },
      assistantTexts: [text],
      currentAttemptAssistant: assistant,
      replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    });
    const resolved = await resolveEmbeddedRunTerminal(
      makeTerminalInput({ attempt, payloadsWithToolMedia: [{ text }] }),
    );
    expect(resolved.action).toBe("complete");
    if (resolved.action === "complete") {
      expect(resolved.result.meta.error).toBeUndefined();
      expect(classifyAgentExecResult(resolved.result).status).toBe("ok");
      expect(resolved.result.payloads).toEqual([{ text }]);
    }
    expect(markEmbeddedRunAuthProfileSuccess).toHaveBeenCalledOnce();
  });

  it.each(["openai:selected", undefined])(
    "reports the successful profile %s privately for command maintenance",
    async (authProfileId) => {
      const text = "The turn completed.";
      const assistant = buildEmbeddedRunnerAssistant({ content: [{ type: "text", text }] });
      const attempt = makeEmbeddedRunnerAttempt({
        assistantTexts: [text],
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
      });
      const onSuccessfulAuthProfile = vi.fn();
      const resolved = await resolveEmbeddedRunTerminal(
        makeTerminalInput({
          attempt,
          attemptAssistant: assistant,
          payloadsWithToolMedia: [{ text }],
          authProfileId,
          runParams: { authProfileStateMode: "read-only", onSuccessfulAuthProfile },
        }),
      );

      expect(resolved.action).toBe("complete");
      expect(onSuccessfulAuthProfile).toHaveBeenCalledExactlyOnceWith(authProfileId);
      if (resolved.action === "complete") {
        expect(resolved.result.meta.agentMeta).not.toHaveProperty("authProfileId");
      }
    },
  );

  it.each([
    {
      reason: "auth" as const,
      expected: "Couldn't sign in to openai. Your saved login looks expired or no longer works.",
    },
    {
      reason: "auth_permanent" as const,
      expected: "openai isn't accepting your saved login.",
    },
  ])("surfaces provider recovery guidance for $reason terminal failures", async (testCase) => {
    const text = await resolveTerminalText({
      assistantProfileFailureReason: testCase.reason,
      maxEmptyResponseRetryAttempts: 0,
    });
    expect(text).toContain(testCase.expected);
    expect(text).toContain("openclaw configure");
  });

  it("keeps non-auth incomplete turns on the generic warning", async () => {
    await expect(
      resolveTerminalText({
        assistantProfileFailureReason: "timeout",
        maxEmptyResponseRetryAttempts: 0,
      }),
    ).resolves.toBe("⚠️ Agent couldn't generate a response. Please try again.");
  });

  it("does not replace timeout suppression with auth guidance", async () => {
    const assistant = emptyAssistant({ stopReason: "aborted" });
    const attempt = makeEmbeddedRunnerAttempt({
      terminal: { kind: "timeout", phase: "prompt", source: "external" },
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
    await expect(
      resolveTerminalText({
        attempt,
        attemptAssistant: assistant,
        assistantProfileFailureReason: "auth",
      }),
    ).resolves.toBeUndefined();
  });

  it("keeps the side-effect warning ahead of auth guidance", async () => {
    const assistant = emptyAssistant({ stopReason: "error" });
    const attempt = makeEmbeddedRunnerAttempt({
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    });
    const text = await resolveTerminalText({
      attempt,
      attemptAssistant: assistant,
      assistantProfileFailureReason: "auth",
      replayState: { hadPotentialSideEffects: true, replayInvalid: true },
    });
    expect(text).toContain("some tool actions may have already been executed");
    expect(text).not.toContain("Couldn't sign in");
  });

  it("retries a required empty reply even when deliberate silence is enabled", async () => {
    const activateInternalPrompt = vi.fn();
    const input = makeTerminalInput({
      runParams: { allowEmptyAssistantReplyAsSilent: true, terminalReplyExpectation: "required" },
      activateInternalPrompt,
    });

    await expect(resolveEmbeddedRunTerminal(input)).resolves.toEqual({ action: "retry" });
    expect(input.retryState.emptyResponseAttempts).toBe(1);
    expect(activateInternalPrompt).toHaveBeenCalledWith(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("completes an explicit silent reply without retrying", async () => {
    const assistant = buildEmbeddedRunnerAssistant({
      content: [{ type: "text", text: SILENT_REPLY_TOKEN }],
    });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [SILENT_REPLY_TOKEN],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
    const activateInternalPrompt = vi.fn();
    const input = makeTerminalInput({
      attempt,
      attemptAssistant: assistant,
      runParams: { allowEmptyAssistantReplyAsSilent: true, terminalReplyExpectation: "required" },
      activateInternalPrompt,
    });

    const resolved = await resolveEmbeddedRunTerminal(input);

    expect(resolved.action).toBe("complete");
    if (resolved.action !== "complete") {
      return;
    }
    expect(resolved.result.payloads).toEqual([{ text: SILENT_REPLY_TOKEN }]);
    expect(resolved.result.meta.terminalReplyKind).toBe("silent-empty");
    expect(resolved.result.meta.livenessState).toBe("working");
    expect(activateInternalPrompt).not.toHaveBeenCalled();
  });

  it("keeps an empty visible parent alive for accepted completion children", async () => {
    const attempt = makeEmbeddedRunnerAttempt({
      acceptedSessionSpawns: [
        {
          runId: "child-run",
          childSessionKey: "agent:main:subagent:child",
          expectsCompletionMessage: true,
        },
      ],
    });

    const resolved = await resolveEmbeddedRunTerminal(
      makeTerminalInput({
        attempt,
        runParams: { replyOperation: { turnKind: "visible" } as never },
      }),
    );

    expect(resolved).toMatchObject({
      result: {
        payloads: [{ text: "I’m continuing this work and will send the result when it is ready." }],
      },
    });
  });

  it("does not add a continuation status when the parent already replied", async () => {
    const text = "The work is complete.";
    const assistant = buildEmbeddedRunnerAssistant({ content: [{ type: "text", text }] });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [text],
      acceptedSessionSpawns: [{ runId: "child-run", childSessionKey: "agent:main:subagent:child" }],
      currentAttemptAssistant: assistant,
      lastAssistant: assistant,
    });

    const resolved = await resolveEmbeddedRunTerminal(
      makeTerminalInput({
        attempt,
        attemptAssistant: assistant,
        payloadsWithToolMedia: [{ text }],
        runParams: { replyOperation: { turnKind: "visible" } as never },
      }),
    );

    expect(resolved.action).toBe("complete");
    if (resolved.action === "complete") {
      expect(resolved.result.payloads).toEqual([{ text }]);
      expect(resolved.result.meta.continuationPending).toBeUndefined();
    }
  });

  it("does not add a continuation status after an unelaborated message delivery", async () => {
    const attempt = makeEmbeddedRunnerAttempt({
      didSendViaMessagingTool: true,
      acceptedSessionSpawns: [
        {
          runId: "child-run",
          childSessionKey: "agent:main:subagent:child",
          expectsCompletionMessage: true,
        },
      ],
    });

    const resolved = await resolveEmbeddedRunTerminal(
      makeTerminalInput({
        attempt,
        runParams: { replyOperation: { turnKind: "visible" } as never },
      }),
    );

    expect(resolved.action).toBe("complete");
    if (resolved.action === "complete") {
      expect(resolved.result.payloads).toBeUndefined();
      expect(resolved.result.meta.continuationPending).toBeUndefined();
    }
  });

  it.each([
    { label: "an exactly settled terminal tool batch", expectedCompletion: "tool-batch" as const },
    { label: "stale terminal metadata", metadata: { toolCallId: "stale-call" } },
    { label: "a reused call id whose current occurrence is nonterminal", reusedCall: true },
    {
      label: "a partially settled batch",
      lifecycle: { startedCount: 2, completedCount: 1, activeCount: 1 },
    },
    { label: "a mixed terminal and nonterminal batch", mixedBatch: true },
    { label: "failed terminal metadata", metadata: { isError: true } },
    {
      label: "an asynchronously running terminal tool",
      expectIncompleteTurn: false,
      metadata: { asyncStarted: true },
    },
    { label: "a failed terminal result", result: { isError: true } },
    { label: "a result with the wrong tool owner", result: { toolName: "another_tool" } },
    { label: "a stale prior-turn result with the reused call id", staleResult: true },
  ])("resolves $label from exact current-batch ownership", async (testCase) => {
    const terminalCall = {
      type: "toolCall" as const,
      id: "terminal-tool-call",
      name: "ask_user",
      arguments: {},
    };
    const otherCall = { ...terminalCall, id: "nonterminal-tool-call", name: "another_tool" };
    const assistant = buildEmbeddedRunnerAssistant({
      stopReason: "toolUse",
      content: [terminalCall, ...(testCase.mixedBatch ? [otherCall] : [])],
    });
    const toolResult = {
      role: "toolResult" as const,
      toolCallId: terminalCall.id,
      toolName: terminalCall.name,
      content: [{ type: "text", text: "The visible question was cancelled." }],
      isError: false,
      ...testCase.result,
    };
    const currentTurn = [
      { role: "user", content: [{ type: "text", text: "Ask the current question." }] },
      assistant,
    ];
    const messagesSnapshot = testCase.staleResult
      ? [
          buildEmbeddedRunnerAssistant({ stopReason: "toolUse", content: [terminalCall] }),
          toolResult,
          ...currentTurn,
        ]
      : [
          ...currentTurn,
          ...(testCase.expectedCompletion
            ? [
                buildEmbeddedRunnerAssistant({
                  content: [{ type: "text", text: "The question was already shown." }],
                }),
              ]
            : []),
          toolResult,
          ...(testCase.mixedBatch
            ? [{ ...toolResult, toolCallId: otherCall.id, toolName: otherCall.name }]
            : []),
        ];
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      toolMetas: [
        {
          toolName: terminalCall.name,
          toolCallId: terminalCall.id,
          terminate: true,
          ...testCase.metadata,
        },
        ...(testCase.reusedCall
          ? [{ toolName: terminalCall.name, toolCallId: terminalCall.id }]
          : []),
        ...(testCase.mixedBatch ? [{ toolName: otherCall.name, toolCallId: otherCall.id }] : []),
      ],
      itemLifecycle: testCase.lifecycle ?? {
        startedCount: testCase.mixedBatch ? 2 : 1,
        completedCount: testCase.mixedBatch ? 2 : 1,
        activeCount: 0,
      },
      messagesSnapshot: messagesSnapshot as TerminalInput["attempt"]["messagesSnapshot"],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
    });
    const input = makeTerminalInput({
      attempt,
      attemptAssistant: assistant,
      replayState: { hadPotentialSideEffects: true, replayInvalid: true },
    });
    const resolved = await resolveEmbeddedRunTerminal(input);

    expect(resolved.action).toBe("complete");
    if (resolved.action === "complete") {
      expect(resolved.result.meta.intentionalTerminalCompletion).toBe(testCase.expectedCompletion);
      if (testCase.expectedCompletion) {
        expect(resolved.result.meta.error).toBeUndefined();
        expect(resolved.result.payloads).toBeUndefined();
        expect(resolved.result.meta.livenessState).toBe("working");
        expect(input.activateInternalPrompt).not.toHaveBeenCalled();
        expect(attempt.messagesSnapshot.at(-1)).toBe(toolResult);
      } else if (testCase.expectIncompleteTurn !== false) {
        expect(resolved.result.meta.error?.kind).toBe("incomplete_turn");
        expect(resolved.result.payloads?.[0]?.isError).toBe(true);
      }
    }
  });

  it("completes a cron turn from a trailing silent tool result", async () => {
    const assistant = emptyAssistant();
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      toolMetas: [{ toolName: "exec" }],
      messagesSnapshot: [
        {
          role: "toolResult",
          content: [{ type: "text", text: SILENT_REPLY_TOKEN }],
          details: { aggregated: SILENT_REPLY_TOKEN },
        } as never,
        assistant,
      ],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
    });
    const activateInternalPrompt = vi.fn();
    const input = makeTerminalInput({
      attempt,
      attemptAssistant: assistant,
      runParams: { trigger: "cron", terminalReplyExpectation: "required" },
      activateInternalPrompt,
    });

    const resolved = await resolveEmbeddedRunTerminal(input);

    expect(resolved.action).toBe("complete");
    if (resolved.action !== "complete") {
      return;
    }
    expect(resolved.result.payloads).toEqual([{ text: SILENT_REPLY_TOKEN }]);
    expect(resolved.result.meta.livenessState).toBe("working");
    expect(activateInternalPrompt).not.toHaveBeenCalled();
  });

  it("keeps a length-stopped silent cron result silent", async () => {
    // The only payload is the synthesized silent result of a successful tool and
    // the assistant produced no prose, so there is no partial reply to label; a
    // truncation notice here would turn intentional silence into a message.
    const assistant = emptyAssistant({ stopReason: "length" });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      toolMetas: [{ toolName: "exec" }],
      messagesSnapshot: [
        {
          role: "toolResult",
          content: [{ type: "text", text: SILENT_REPLY_TOKEN }],
          details: { aggregated: SILENT_REPLY_TOKEN },
        } as never,
        assistant,
      ],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
    });
    const input = makeTerminalInput({
      attempt,
      attemptAssistant: assistant,
      runParams: { trigger: "cron", terminalReplyExpectation: "required" },
    });

    const resolved = await resolveEmbeddedRunTerminal(input);

    expect(resolved.action).toBe("complete");
    if (resolved.action !== "complete") {
      return;
    }
    expect(resolved.result.payloads).toEqual([{ text: SILENT_REPLY_TOKEN }]);
  });

  it("completes a reply-optional side-effecting turn as intentional silence", async () => {
    const assistant = emptyAssistant();
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      toolMetas: [{ toolName: "sessions", meta: "patch archived", replaySafe: false }],
      itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
    });
    const input = makeTerminalInput({
      attempt,
      attemptAssistant: assistant,
      replayState: { ...attempt.replayMetadata, replayInvalid: false },
      runParams: {
        trigger: "cron",
        allowEmptyAssistantReplyAsSilent: true,
        terminalReplyExpectation: "optional",
      },
    });

    const resolved = await resolveEmbeddedRunTerminal(input);

    expect(resolved.action).toBe("complete");
    if (resolved.action !== "complete") {
      return;
    }
    expect(resolved.result.payloads).toEqual([{ text: SILENT_REPLY_TOKEN }]);
    expect(resolved.result.meta.error).toBeUndefined();
    expect(resolved.result.meta.terminalReplyKind).toBe("silent-empty");
  });

  it.each([
    { label: "empty", rawText: undefined, expectedKind: undefined },
    { label: "explicit silence", rawText: "NO_REPLY", expectedKind: "silent-empty" },
  ])(
    "keeps reply-optional subagent $label distinct at the terminal producer",
    async ({ rawText, expectedKind }) => {
      const assistant = emptyAssistant();
      const attempt = makeEmbeddedRunnerAttempt({
        assistantTexts: rawText ? [rawText] : [],
        toolMetas: [{ toolName: "write", replaySafe: false }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
      });
      const input = makeTerminalInput({
        attempt,
        attemptAssistant: assistant,
        finalAssistantRawText: rawText,
        replayState: { ...attempt.replayMetadata, replayInvalid: false },
        runParams: {
          lane: "subagent",
          allowEmptyAssistantReplyAsSilent: true,
          terminalReplyExpectation: "optional",
        },
      });

      const resolved = await resolveEmbeddedRunTerminal(input);

      expect(resolved.action).toBe("complete");
      if (resolved.action !== "complete") {
        return;
      }
      expect(resolved.result.meta.terminalReplyKind).toBe(expectedKind);
    },
  );

  it("retries reasoning-only output and surfaces a retained presentation after exhaustion", async () => {
    const assistant = buildEmbeddedRunnerAssistant({
      content: [
        {
          type: "thinking",
          thinking: "internal reasoning",
          thinkingSignature: JSON.stringify({ id: "rs_terminal", type: "reasoning" }),
        },
      ],
    });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
    const activateInternalPrompt = vi.fn();
    const retryInput = makeTerminalInput({
      attempt,
      attemptAssistant: assistant,
      runParams: { allowEmptyAssistantReplyAsSilent: true, terminalReplyExpectation: "required" },
      activateInternalPrompt,
    });

    await expect(resolveEmbeddedRunTerminal(retryInput)).resolves.toEqual({ action: "retry" });
    expect(activateInternalPrompt).toHaveBeenCalledWith(REASONING_ONLY_RETRY_INSTRUCTION);

    const exhaustedInput = makeTerminalInput({
      attempt,
      attemptAssistant: assistant,
      retryState: { ...createEmbeddedRunTerminalRetryState(), reasoningOnlyAttempts: 2 },
      readTerminalToolPresentation: () =>
        "Web fetch completed.\nOrigin: https://example.com\nStatus: 200",
    });
    const exhausted = await resolveEmbeddedRunTerminal(exhaustedInput);

    expect(exhausted.action).toBe("complete");
    if (exhausted.action !== "complete") {
      return;
    }
    expect(exhausted.result.payloads).toEqual([
      {
        text:
          "Web fetch completed.\nOrigin: https://example.com\nStatus: 200\n\n" +
          "⚠️ Agent couldn't generate a response. Please try again.",
        isError: true,
      },
    ]);
    expect(exhausted.result.meta.error).toMatchObject({
      kind: "incomplete_turn",
      fallbackSafe: true,
      terminalPresentation: true,
    });
  });

  it("does not surface a read-only presentation after a sibling side effect", async () => {
    const assistant = buildEmbeddedRunnerAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tool-1", name: "exec", arguments: {} }],
    });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      toolMetas: [
        { toolName: "exec", replaySafe: false },
        { toolName: "web_fetch", replaySafe: true },
      ],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    });
    const resolved = await resolveEmbeddedRunTerminal(
      makeTerminalInput({
        attempt,
        attemptAssistant: assistant,
        replayState: { hadPotentialSideEffects: true, replayInvalid: true },
        readTerminalToolPresentation: () => "Fetched https://example.com",
      }),
    );

    expect(resolved.action).toBe("complete");
    if (resolved.action !== "complete") {
      return;
    }
    expect(resolved.result.payloads?.[0]?.text).not.toContain("Fetched https://example.com");
    expect(resolved.result.meta.error).toMatchObject({
      kind: "incomplete_turn",
      fallbackSafe: false,
    });
    expect(resolved.result.meta.error?.terminalPresentation).toBe(false);
  });

  it.each([
    { activePromptPersisted: true, expectedSuppression: true },
    { activePromptPersisted: false, expectedSuppression: false },
  ])(
    "retries a missing assistant with suppression=$expectedSuppression",
    async ({ activePromptPersisted, expectedSuppression }) => {
      const attempt = makeEmbeddedRunnerAttempt({
        assistantTexts: [],
        lastAssistant: undefined,
        currentAttemptAssistant: undefined,
        currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
      });
      const setSuppressNextUserMessagePersistence = vi.fn();
      const activateInternalPrompt = vi.fn();
      const input = makeTerminalInput({
        attempt,
        attemptAssistant: undefined,
        activePromptPersisted,
        setSuppressNextUserMessagePersistence,
        activateInternalPrompt,
      });

      await expect(resolveEmbeddedRunTerminal(input)).resolves.toEqual({ action: "retry" });
      expect(setSuppressNextUserMessagePersistence).toHaveBeenCalledWith(expectedSuppression);
      expect(activateInternalPrompt).not.toHaveBeenCalled();
    },
  );

  it("activates the prompt owner for an OpenAI Responses compaction checkpoint", async () => {
    const assistant = buildEmbeddedRunnerAssistant({
      stopReason: "length",
      providerReplay: {
        v: 1,
        type: "openai-responses-compaction",
        id: "cmp-terminal-retry",
        data: "opaque-compaction",
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.6-luna",
        baseUrlHash: "base-url-hash",
      },
    });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
    const activateCompactionContinuation = vi.fn();
    const input = makeTerminalInput({
      attempt,
      attemptAssistant: assistant,
      activateCompactionContinuation,
    });

    await expect(resolveEmbeddedRunTerminal(input)).resolves.toEqual({ action: "retry" });
    expect(activateCompactionContinuation).toHaveBeenCalledWith(
      expect.stringContaining("Continue from the compacted transcript"),
    );
    expect(input.armPostCompactionGuard).toHaveBeenCalledOnce();
  });

  it.each([
    { expectation: "required" as const, expectedError: true },
    { expectation: "optional" as const, expectedError: false },
  ])(
    "handles completed-empty finalization for $expectation replies",
    async ({ expectation, expectedError }) => {
      const assistant = emptyAssistant();
      const attempt = makeEmbeddedRunnerAttempt({
        assistantTexts: [],
        toolMetas: [{ toolName: "write", replaySafe: false }],
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
        replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      });
      const resolved = await resolveEmbeddedRunTerminal(
        makeTerminalInput({
          attempt,
          attemptAssistant: assistant,
          runParams: {
            allowEmptyAssistantReplyAsSilent: true,
            terminalReplyExpectation: expectation,
          },
          replayState: { hadPotentialSideEffects: true, replayInvalid: true },
          settledTurnFinalizationOutcome: "completed-empty",
        }),
      );

      expect(resolved.action).toBe("complete");
      if (resolved.action !== "complete") {
        return;
      }
      if (expectedError) {
        expect(resolved.result.payloads?.[0]).toMatchObject({ isError: true });
        expect(resolved.result.meta.error?.kind).toBe("incomplete_turn");
        expect(resolved.result.meta.terminalReplyKind).toBeUndefined();
      } else {
        expect(resolved.result.payloads).toBeUndefined();
        expect(resolved.result.meta.error).toBeUndefined();
        expect(resolved.result.meta.terminalReplyKind).toBeUndefined();
      }
    },
  );

  it("does not retry after isolated finalization fails", async () => {
    const assistant = buildEmbeddedRunnerAssistant({
      content: [
        {
          type: "thinking",
          thinking: "internal reasoning",
          thinkingSignature: JSON.stringify({ id: "rs-finalizer-failed", type: "reasoning" }),
        },
      ],
    });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
    const activateInternalPrompt = vi.fn();
    const resolved = await resolveEmbeddedRunTerminal(
      makeTerminalInput({
        attempt,
        attemptAssistant: assistant,
        activateInternalPrompt,
        settledTurnFinalizationOutcome: "failed",
      }),
    );

    expect(resolved.action).toBe("complete");
    expect(activateInternalPrompt).not.toHaveBeenCalled();
  });

  it("delivers partial text with a truncation notice when the output budget ends", async () => {
    const assistant = buildEmbeddedRunnerAssistant({
      stopReason: "length",
      content: [{ type: "text", text: "Here is the first half of the answer" }],
    });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: ["Here is the first half of the answer"],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
    const resolved = await resolveEmbeddedRunTerminal(
      makeTerminalInput({
        attempt,
        attemptAssistant: assistant,
        payloadsWithToolMedia: [{ text: "Here is the first half of the answer" }],
      }),
    );

    expect(resolved.action).toBe("complete");
    if (resolved.action !== "complete") {
      return;
    }
    expect(resolved.result.payloads).toEqual([
      { text: "Here is the first half of the answer" },
      { text: TRUNCATED_REPLY_NOTICE_TEXT },
    ]);
    expect(resolved.result.meta.error).toBeUndefined();
    expect(resolved.result.meta.livenessState).toBe("working");
  });

  it("does not add a truncation notice to a length stop that already has terminal output", async () => {
    // Terminal tool media was already a complete outcome before this fix, so it
    // must not gain a notice telling the user to ask for a continuation.
    const assistant = buildEmbeddedRunnerAssistant({
      stopReason: "length",
      content: [{ type: "text", text: "Chart attached" }],
    });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: ["Chart attached"],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      toolMediaUrls: ["https://example.invalid/chart.png"],
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
    const resolved = await resolveEmbeddedRunTerminal(
      makeTerminalInput({
        attempt,
        attemptAssistant: assistant,
        payloadsWithToolMedia: [{ text: "Chart attached" }],
      }),
    );

    expect(resolved.action).toBe("complete");
    if (resolved.action !== "complete") {
      return;
    }
    expect(resolved.result.payloads).toEqual([{ text: "Chart attached" }]);
  });

  it("still reports an incomplete turn when auth failure bookkeeping rejects", async () => {
    const assistant = emptyAssistant({ stopReason: "length" });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
    const maybeMarkAuthProfileFailure = vi.fn(async () => {
      throw new Error("injected auth store write failure");
    });
    const resolved = await resolveEmbeddedRunTerminal(
      makeTerminalInput({
        attempt,
        attemptAssistant: assistant,
        authProfileId: "openai:default",
        assistantProfileFailureReason: "unknown",
        maybeMarkAuthProfileFailure,
      }),
    );

    expect(resolved.action).toBe("complete");
    if (resolved.action !== "complete") {
      return;
    }
    expect(resolved.result.payloads?.[0]).toMatchObject({ isError: true });
    expect(resolved.result.meta.error?.kind).toBe("incomplete_turn");
    expect(resolved.result.meta.livenessState).toBe("abandoned");
    expect(maybeMarkAuthProfileFailure).toHaveBeenCalledWith({
      profileId: "openai:default",
      reason: "unknown",
      modelId: "gpt-5.6-luna",
    });
  });
});
