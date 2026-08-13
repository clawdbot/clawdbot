import { describe, expect, it, vi } from "vitest";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { createEmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./terminal-outcome.js";
import {
  copyAttemptDeliveryState,
  createTerminalToolPresentationTracker,
  resolveEmbeddedRunTerminal,
  resolveSettledTurnFinalizationRequest,
} from "./terminal-resolution.js";
import { createEmbeddedRunTerminalRetryState } from "./terminal-retry-state.js";

const EMPTY_RESPONSE_RETRY_INSTRUCTION =
  "The previous attempt did not produce a user-visible answer. Continue from the current state and produce the visible answer now. Do not restart from scratch.";
const REASONING_ONLY_RETRY_INSTRUCTION =
  "The previous assistant turn recorded reasoning but did not produce a user-visible answer. Continue from that partial turn and produce the visible answer now. Do not restate the reasoning or restart from scratch.";
const SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION =
  "The previous assistant turn completed its tool calls but did not produce a user-visible answer. Continue from the current transcript and produce the final user-visible answer now. Do not repeat completed tool calls or restart from scratch.";

type TerminalInput = Parameters<typeof resolveEmbeddedRunTerminal>[0];
type TerminalInputOverrides = Omit<Partial<TerminalInput>, "runParams"> & {
  runParams?: Partial<TerminalInput["runParams"]>;
};

function emptyAssistant(overrides: Parameters<typeof buildEmbeddedRunnerAssistant>[0] = {}) {
  return buildEmbeddedRunnerAssistant({
    content: [{ type: "text", text: "" }],
    ...overrides,
  });
}

function makeTerminalInput(overrides: TerminalInputOverrides = {}): TerminalInput {
  const assistant = overrides.attemptAssistant ?? emptyAssistant();
  const attempt =
    overrides.attempt ??
    makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
  const profileStore = { version: 1, profiles: {} } as never;
  const runParams = {
    sessionId: "session:terminal-resolution",
    sessionKey: "agent:main:terminal-resolution",
    runId: "run:terminal-resolution",
    agentDir: "/tmp/openclaw-terminal-resolution",
    ...overrides.runParams,
  } as TerminalInput["runParams"];
  const base = {
    runParams,
    retryState: createEmbeddedRunTerminalRetryState(),
    attempt,
    attemptAssistant: attempt.currentAttemptAssistant ?? attempt.lastAssistant,
    activeErrorContext: { provider: "openai", model: "gpt-5.6-luna" },
    modelApi: "openai-responses",
    executionContract: undefined,
    terminalState: resolveEmbeddedRunAttemptTerminalState({
      attempt,
      assistant: attempt.currentAttemptAssistant ?? attempt.lastAssistant,
    }),
    payloadsWithToolMedia: [],
    recoveredFinalAssistantPayloadsAfterPromptTimeout: undefined,
    finalAssistantVisibleText: undefined,
    finalAssistantRawText: undefined,
    agentMeta: {} as never,
    attemptToolSummary: undefined,
    failureSignal: undefined,
    maxReasoningOnlyRetryAttempts: 2,
    maxEmptyResponseRetryAttempts: 1,
    attemptCompactionCount: 0,
    replayState: { ...attempt.replayMetadata, replayInvalid: false },
    activePromptPersisted: true,
    activateInternalPrompt: vi.fn(),
    setSuppressNextUserMessagePersistence: vi.fn(),
    armPostCompactionGuard: vi.fn(),
    readTerminalToolPresentation: () => undefined,
    resolveReplayInvalid: () => false,
    setTerminalLifecycleMeta: vi.fn(),
    maybeMarkAuthProfileFailure: vi.fn(async () => undefined),
    assistantProfileFailureReason: null,
    startedAtMs: Date.now(),
    provider: "openai",
    modelId: "gpt-5.6-luna",
    modelTransportId: "gpt-5.6-luna",
    modelTransportApi: "openai-responses",
    requestTransportOverrides: "none",
    authProfileId: undefined,
    profileFailureStore: profileStore,
    attemptAuthProfileStore: profileStore,
    apiKeyInfo: null,
    agentHarnessId: "builtin-openclaw",
    settledTurnFinalizationOutcome: "not-attempted",
    pluginHarnessOwnsTransport: false,
    pluginHarnessOwnsAuthBootstrap: false,
    reportedModelRef: { provider: "openai", model: "gpt-5.6-luna" },
    traceAttempts: [],
    traceAttemptUsesFallback: () => false,
    thinkLevel: "off",
    contextRecoveryState: createEmbeddedRunContextRecoveryState(),
  } satisfies TerminalInput;
  return { ...base, ...overrides, runParams };
}

describe("terminal resolution", () => {
  it("carries presentation across retries until a newer tool outcome replaces it", () => {
    const tracker = createTerminalToolPresentationTracker();
    const firstOrdinal = tracker.allocateOrdinal();
    tracker.observe({
      toolCallOrdinal: firstOrdinal,
      terminalPresentation: "Fetched https://example.com",
    });

    expect(tracker.read()).toBe("Fetched https://example.com");

    const retryOrdinal = tracker.allocateOrdinal();
    expect(tracker.read()).toBe("Fetched https://example.com");
    tracker.observe({ toolCallOrdinal: retryOrdinal });
    tracker.observe({
      toolCallOrdinal: firstOrdinal,
      terminalPresentation: "stale presentation",
    });

    expect(tracker.read()).toBeUndefined();
  });

  it("keeps only the bounded latest MCP App view identity", () => {
    expect(
      copyAttemptDeliveryState({
        latestMcpAppChannelView: { viewId: "view-latest" },
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [],
      } as never).latestMcpAppChannelView,
    ).toEqual({ viewId: "view-latest" });
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

  it("requests isolated finalization only for a required settled-tool turn", () => {
    const assistant = emptyAssistant();
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      toolMetas: [{ toolName: "write", meta: "path=note.txt", replaySafe: false }],
      itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
    const terminalState = resolveEmbeddedRunAttemptTerminalState({ attempt, assistant });
    const request = (terminalReplyExpectation: "required" | "optional") =>
      resolveSettledTurnFinalizationRequest({
        runParams: {
          sessionId: "session:settled",
          runId: "run:settled",
          terminalReplyExpectation,
        } as never,
        attempt,
        activeErrorContext: { provider: "openai", model: "gpt-5.6-luna" },
        modelApi: "openai-responses",
        executionContract: undefined,
        payloadsWithToolMedia: [],
        hasTerminalToolPresentation: false,
        terminalState,
        settledTurnFinalizationAvailable: true,
      });

    expect(request("required")).toBe(SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION);
    expect(request("optional")).toBeNull();
    expect(
      resolveSettledTurnFinalizationRequest({
        runParams: {
          sessionId: "session:settled-heartbeat",
          runId: "run:settled-heartbeat",
          trigger: "heartbeat",
        } as never,
        attempt,
        activeErrorContext: { provider: "openai", model: "gpt-5.6-luna" },
        modelApi: "openai-responses",
        executionContract: undefined,
        payloadsWithToolMedia: [],
        hasTerminalToolPresentation: false,
        terminalState,
        settledTurnFinalizationAvailable: true,
      }),
    ).toBeNull();
  });

  it("requires an available finalizer and no visible structured error", () => {
    const assistant = buildEmbeddedRunnerAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tool-1", name: "exec", arguments: {} }],
    });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      toolMetas: [{ toolName: "exec", isError: true, replaySafe: false }],
      itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
      messagesSnapshot: [
        assistant,
        { role: "toolResult", toolCallId: "tool-1", toolName: "exec", isError: true } as never,
      ],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      lastToolError: { toolName: "exec", error: "post-processing error" },
    });
    const terminalState = resolveEmbeddedRunAttemptTerminalState({ attempt, assistant });
    const request = (overrides: {
      payloadsWithToolMedia?: TerminalInput["payloadsWithToolMedia"];
      settledTurnFinalizationAvailable?: boolean;
    }) =>
      resolveSettledTurnFinalizationRequest({
        runParams: {
          sessionId: "session:settled-policy",
          runId: "run:settled-policy",
          trigger: "user",
          terminalReplyExpectation: "required",
        } as never,
        attempt,
        activeErrorContext: { provider: "openai", model: "gpt-5.6-luna" },
        modelApi: "openai-responses",
        executionContract: undefined,
        payloadsWithToolMedia: overrides.payloadsWithToolMedia ?? [],
        hasTerminalToolPresentation: false,
        terminalState,
        settledTurnFinalizationAvailable: overrides.settledTurnFinalizationAvailable ?? true,
      });

    expect(
      request({
        payloadsWithToolMedia: [
          {
            text: "Review the failed operation.",
            isError: true,
            channelData: { structuredError: true },
          },
        ],
      }),
    ).toBeNull();
    expect(request({ settledTurnFinalizationAvailable: false })).toBeNull();
    expect(
      request({ payloadsWithToolMedia: [{ text: "⚠️ 🛠️ Exec failed", isError: true }] }),
    ).toContain(SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION);
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
});
