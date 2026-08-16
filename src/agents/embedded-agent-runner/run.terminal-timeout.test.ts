import { describe, expect, it, vi } from "vitest";
import { resolveEmbeddedRunAttemptTerminalState } from "./run/terminal-outcome.js";
import { resolveEmbeddedRunTerminalTimeout } from "./run/terminal-timeout.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

function makeTimedOutAttempt(
  overrides: Partial<EmbeddedRunAttemptResult> = {},
): EmbeddedRunAttemptResult {
  return {
    terminal: { kind: "timeout", phase: "prompt", source: "runtime", aborted: true },
    sessionIdUsed: "session-1",
    messagesSnapshot: [],
    assistantTexts: [],
    toolMetas: [],
    lastAssistant: undefined,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
    ...overrides,
  };
}

function makeTimeoutInput(
  attempt: EmbeddedRunAttemptResult,
  overrides: Partial<Parameters<typeof resolveEmbeddedRunTerminalTimeout>[0]> = {},
): Parameters<typeof resolveEmbeddedRunTerminalTimeout>[0] {
  return {
    timedOutDuringPrompt: true,
    hasSuccessfulFinalAssistantAfterPromptTimeout: false,
    shouldSurfaceCodexCompletionTimeout: false,
    attempt,
    hasPartialAssistantTextAfterPromptTimeout: false,
    payloads: undefined,
    payloadsWithToolMedia: undefined,
    terminalState: resolveEmbeddedRunAttemptTerminalState({
      attempt,
      assistant: attempt.lastAssistant,
    }),
    resolveReplayInvalid: vi.fn(() => false),
    setTerminalLifecycleMeta: vi.fn(),
    startedAtMs: Date.now(),
    agentMeta: {
      sessionId: "session-1",
      provider: "openai",
      model: "gpt-5.6-luna",
    },
    attemptToolSummary: undefined,
    failureSignal: undefined,
    ...overrides,
  };
}

describe("resolveEmbeddedRunTerminalTimeout", () => {
  it("returns an explicit default timeout payload when no reply was produced", () => {
    const result = resolveEmbeddedRunTerminalTimeout(makeTimeoutInput(makeTimedOutAttempt()));

    expect(result?.payloads).toEqual([
      { text: expect.stringContaining("timed out"), isError: true },
    ]);
  });

  it("preserves an accepted child spawn while surfacing the parent timeout", () => {
    const acceptedSessionSpawns = [
      { runId: "run-child", childSessionKey: "agent:claude:subagent:child" },
    ];
    const result = resolveEmbeddedRunTerminalTimeout(
      makeTimeoutInput(makeTimedOutAttempt({ acceptedSessionSpawns })),
    );

    expect(result?.payloads).toEqual([
      { text: expect.stringContaining("timed out"), isError: true },
    ]);
    expect(result?.acceptedSessionSpawns).toEqual(acceptedSessionSpawns);
  });

  it("does not replace a successfully recovered final assistant after a prompt-timeout race", () => {
    expect(
      resolveEmbeddedRunTerminalTimeout(
        makeTimeoutInput(makeTimedOutAttempt(), {
          hasSuccessfulFinalAssistantAfterPromptTimeout: true,
          payloads: [{ text: "Completed answer after the timeout race." }],
          payloadsWithToolMedia: [{ text: "Completed answer after the timeout race." }],
        }),
      ),
    ).toBeUndefined();
  });

  it("prefers harness timeout metadata while retaining terminal attribution", () => {
    const setTerminalLifecycleMeta = vi.fn();
    const attempt = makeTimedOutAttempt({
      promptTimeoutOutcome: {
        message: "Harness stopped after completed work without terminal confirmation.",
        replayInvalid: true,
        livenessState: "abandoned",
      },
    });

    const result = resolveEmbeddedRunTerminalTimeout(
      makeTimeoutInput(attempt, { setTerminalLifecycleMeta }),
    );

    expect(result?.payloads).toEqual([
      {
        text: "Harness stopped after completed work without terminal confirmation.",
        isError: true,
      },
    ]);
    expect(result?.meta).toMatchObject({
      replayInvalid: true,
      livenessState: "abandoned",
      timeoutPhase: "provider",
      providerStarted: true,
    });
    expect(setTerminalLifecycleMeta).toHaveBeenCalledWith({
      replayInvalid: true,
      livenessState: "abandoned",
      timeoutPhase: "provider",
      providerStarted: true,
    });
  });

  it("suppresses the generic timeout payload after messaging-tool delivery", () => {
    const attempt = makeTimedOutAttempt({
      didSendViaMessagingTool: true,
      messagingToolSentTexts: ["already delivered"],
    });

    expect(resolveEmbeddedRunTerminalTimeout(makeTimeoutInput(attempt))).toBeUndefined();
  });

  it("replaces a partial assistant fragment with the timeout error", () => {
    const partialPayload = { text: "# Current Tasks\n\nLast updated:" };
    const result = resolveEmbeddedRunTerminalTimeout(
      makeTimeoutInput(makeTimedOutAttempt(), {
        hasPartialAssistantTextAfterPromptTimeout: true,
        payloads: [partialPayload],
        payloadsWithToolMedia: [partialPayload],
      }),
    );

    expect(result?.payloads).toEqual([
      { text: expect.stringContaining("timed out"), isError: true },
    ]);
  });

  it("preserves tool media before appending the timeout error", () => {
    const mediaPayload = {
      mediaUrl: "https://example.test/tool-output.png",
      mediaUrls: ["https://example.test/tool-output.png"],
    };
    const result = resolveEmbeddedRunTerminalTimeout(
      makeTimeoutInput(makeTimedOutAttempt(), {
        payloads: [mediaPayload],
        payloadsWithToolMedia: [mediaPayload],
      }),
    );

    expect(result?.payloads).toEqual([
      mediaPayload,
      { text: expect.stringContaining("timed out"), isError: true },
    ]);
  });
});
