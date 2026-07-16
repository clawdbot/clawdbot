import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSystemPromptReport } from "../../../config/sessions/types.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { ToolResultPromptProjectionState } from "../session-prompt-state.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const hoisted = vi.hoisted(() => ({
  info: vi.fn(),
  resolveLiveToolResultAggregateMaxChars: vi.fn(() => 200),
  resolveLiveToolResultMaxChars: vi.fn(() => 100),
  truncateOversizedToolResultsInMessages: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  log: { info: hoisted.info, warn: hoisted.warn },
}));
vi.mock("../tool-result-truncation.js", () => ({
  resolveLiveToolResultAggregateMaxChars: hoisted.resolveLiveToolResultAggregateMaxChars,
  resolveLiveToolResultMaxChars: hoisted.resolveLiveToolResultMaxChars,
  truncateOversizedToolResultsInMessages: hoisted.truncateOversizedToolResultsInMessages,
}));

import { prepareEmbeddedAttemptPromptContext } from "./attempt-prompt-context.js";

const messages = [
  {
    role: "user",
    content: [{ type: "text", text: "Previous request" }],
    timestamp: 100,
  },
] as AgentMessage[];

const projectionState: ToolResultPromptProjectionState = {
  replacements: new Map(),
  frozen: new Set(),
  ambiguousBaseKeys: new Set(),
  sourceTextByKey: new Map(),
};

function createAttempt(overrides?: Partial<EmbeddedRunAttemptParams>) {
  return {
    config: {},
    contextTokenBudget: 32_000,
    currentInboundContext: {
      text: "Conversation info (untrusted metadata): channel=telegram",
    },
    currentInboundEventKind: "user_request",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    suppressNextUserMessagePersistence: false,
    ...overrides,
  } as EmbeddedRunAttemptParams;
}

function createPrompt(overrides?: Record<string, unknown>) {
  return {
    effectivePrompt: "Visible request",
    promptBeforePromptBuildHooks: "Visible request",
    hasPromptBuildContext: false,
    effectiveTranscriptPrompt: "Visible request",
    transcriptPromptForRuntimeSplit: "Visible request",
    promptForRuntimeContextSplit: "Visible request",
    promptForModelBeforeRuntimeContextSplit: "Visible request",
    promptForRuntimeContextBeforeAnnotation: "Visible request",
    ...overrides,
  };
}

function createInput(options?: {
  attempt?: EmbeddedRunAttemptParams;
  preparedUserTurnMessage?: AgentMessage;
  prompt?: ReturnType<typeof createPrompt>;
  report?: SessionSystemPromptReport;
}) {
  const replaceSessionMessages = vi.fn();
  const setActiveSessionSystemPrompt = vi.fn();
  const report = options?.report ?? ({} as SessionSystemPromptReport);
  return {
    input: {
      attempt: options?.attempt ?? createAttempt(),
      includeBoundaryTimestamp: false,
      isRawModelRun: false,
      messages,
      preparedUserTurnMessage:
        options?.preparedUserTurnMessage ??
        ({ role: "user", content: "Visible request", timestamp: 123 } as AgentMessage),
      prompt: options?.prompt ?? createPrompt(),
      replaceSessionMessages,
      sessionAgentId: "agent-1",
      setActiveSessionSystemPrompt,
      systemPromptReport: report,
      systemPromptText: "Base system prompt",
      toolResultPromptProjectionState: projectionState,
    },
    replaceSessionMessages,
    report,
    setActiveSessionSystemPrompt,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.truncateOversizedToolResultsInMessages.mockImplementation((inputMessages) => ({
    messages: inputMessages,
    truncatedCount: 0,
    aggregateTruncatedCount: 0,
    aggregatePressureEngaged: false,
    aggregateBudgetChars: 200,
  }));
});

describe("prepareEmbeddedAttemptPromptContext", () => {
  it("keeps the transcript prompt bare while carrying inbound context to hooks", () => {
    const fixture = createInput();

    const result = prepareEmbeddedAttemptPromptContext(fixture.input);

    expect(result.promptForSession).toBe("Visible request");
    expect(result.promptForModel).toBe("Visible request");
    expect(result.currentUserTimestampOverride).toEqual({
      timestamp: 123,
      text: "Visible request",
    });
    expect(result.runtimeContextMessageForCurrentTurn?.content).toContain(
      "Conversation info (untrusted metadata)",
    );
    expect(result.hookMessagesForCurrentPrompt.some((message) => message.role === "custom")).toBe(
      true,
    );
    expect(result.prePromptMessageCount).toBe(1);
    expect(result.contextTokenBudget).toBe(32_000);
    expect(result.promptToolResultMaxChars).toBe(100);
    expect(result.promptToolResultAggregateMaxChars).toBe(200);
    expect(fixture.report.currentTurn).toEqual({
      kind: "user_request",
      promptChars: "Visible request".length,
      runtimeContextChars: "Conversation info (untrusted metadata): channel=telegram".length,
      modelOnlyPromptChars: 0,
    });
    expect(fixture.replaceSessionMessages).not.toHaveBeenCalled();
    expect(fixture.setActiveSessionSystemPrompt).not.toHaveBeenCalled();
    const clonedProjectionState = hoisted.truncateOversizedToolResultsInMessages.mock.calls[0]?.[4];
    expect(clonedProjectionState).not.toBe(projectionState);
  });

  it("includes persisted sender context in the overflow-precheck prompt", () => {
    const fixture = createInput({
      preparedUserTurnMessage: {
        role: "user",
        content: "Visible request",
        timestamp: 123,
        __openclaw: { senderId: "alice-id", senderName: "Alice" },
      } as AgentMessage,
    });

    const result = prepareEmbeddedAttemptPromptContext(fixture.input);

    expect(result.llmBoundaryPromptForPrecheck).toContain('"name": "Alice"');
    expect(result.llmBoundaryPromptForPrecheck).toContain("Visible request");
  });

  it("reports aggregate tool-result pressure for compact-then-truncate routing", () => {
    hoisted.truncateOversizedToolResultsInMessages.mockImplementation((inputMessages) => ({
      messages: [...inputMessages],
      truncatedCount: 2,
      aggregateTruncatedCount: 1,
      aggregatePressureEngaged: true,
      aggregateBudgetChars: 200,
    }));
    const fixture = createInput({
      attempt: createAttempt({ sessionId: "pressure-session", sessionKey: "pressure-session" }),
    });

    const result = prepareEmbeddedAttemptPromptContext(fixture.input);

    expect(result.aggregatePressureEngaged).toBe(true);
    expect(hoisted.warn).toHaveBeenCalledWith(
      expect.stringContaining("aggregate tool-result pressure"),
    );
  });

  it("moves runtime-only context into the active system prompt", () => {
    const fixture = createInput({
      attempt: createAttempt({
        currentInboundContext: { text: "Room event metadata" },
        currentInboundEventKind: "room_event",
      }),
      prompt: createPrompt({
        effectivePrompt: "Runtime room event",
        effectiveTranscriptPrompt: "",
        transcriptPromptForRuntimeSplit: "",
        promptForRuntimeContextSplit: "Runtime room event",
        promptForModelBeforeRuntimeContextSplit: "Runtime room event",
      }),
    });

    const result = prepareEmbeddedAttemptPromptContext(fixture.input);

    expect(result.promptSubmission.runtimeOnly).toBe(true);
    expect(result.promptForSession).toContain("Room event metadata");
    expect(result.runtimeContextMessageForCurrentTurn).toBeUndefined();
    expect(result.systemPromptForHook).toContain("Runtime room event");
    expect(fixture.setActiveSessionSystemPrompt).toHaveBeenCalledWith(
      expect.stringContaining("Runtime room event"),
    );
    expect(fixture.report.currentTurn?.kind).toBe("room_event");
    expect(fixture.report.currentTurn?.runtimeContextChars).toBeGreaterThan(0);
  });
});
