import { QUEUED_USER_MESSAGE_MARKER } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSystemPromptReport } from "../../../config/sessions/types.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { ToolResultPromptProjectionState } from "../session-prompt-state.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const hoisted = vi.hoisted(() => ({
  info: vi.fn(),
  promptPressureKeys: new Set<string>(),
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
  toolResultWarningDedupe: {
    promptPressure: {
      check: (key: string) => {
        if (hoisted.promptPressureKeys.has(key)) {
          return true;
        }
        hoisted.promptPressureKeys.add(key);
        return false;
      },
    },
  },
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
  hoisted.promptPressureKeys.clear();
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

  it("injects the latest heartbeat outcome only as hidden runtime context", () => {
    const fixture = createInput();
    const result = prepareEmbeddedAttemptPromptContext({
      ...fixture.input,
      heartbeatOutcomeContext: "Latest silent heartbeat outcome: deployment finished",
    });

    expect(result.promptForSession).toBe("Visible request");
    expect(result.promptForModel).toBe("Visible request");
    expect(result.runtimeContextMessageForCurrentTurn?.content).toContain(
      "Latest silent heartbeat outcome: deployment finished",
    );
    expect(result.llmBoundaryPromptForPrecheck).not.toContain("deployment finished");
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

  it("deduplicates aggregate pressure warnings per session key", () => {
    hoisted.truncateOversizedToolResultsInMessages.mockImplementation((inputMessages) => ({
      messages: [...inputMessages],
      truncatedCount: 1,
      aggregateTruncatedCount: 1,
      aggregatePressureEngaged: true,
      aggregateBudgetChars: 200,
    }));
    const attempt = createAttempt({ sessionId: "dup-session", sessionKey: "dup-session" });

    prepareEmbeddedAttemptPromptContext(createInput({ attempt }).input);
    expect(hoisted.warn).toHaveBeenCalledTimes(1);
    hoisted.warn.mockClear();

    prepareEmbeddedAttemptPromptContext(createInput({ attempt }).input);
    expect(hoisted.warn).not.toHaveBeenCalled();
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

  it("keeps a pure heartbeat task active while persisting only the poll marker", () => {
    const taskPrompt = "Check the deployment and report any failures.";
    const transcriptPrompt = "[OpenClaw heartbeat poll]";
    const fixture = createInput({
      attempt: createAttempt({ currentInboundContext: undefined }),
      prompt: createPrompt({
        effectivePrompt: taskPrompt,
        promptBeforePromptBuildHooks: taskPrompt,
        effectiveTranscriptPrompt: transcriptPrompt,
        transcriptPromptForRuntimeSplit: transcriptPrompt,
        promptForRuntimeContextSplit: taskPrompt,
        promptForModelBeforeRuntimeContextSplit: taskPrompt,
        promptForRuntimeContextBeforeAnnotation: taskPrompt,
      }),
    });

    const result = prepareEmbeddedAttemptPromptContext(fixture.input);

    expect(result.promptForSession).toBe(transcriptPrompt);
    expect(result.promptForModel).toBe(taskPrompt);
    expect(result.promptSubmission.runtimeContext).toBeUndefined();
    expect(result.runtimeContextMessageForCurrentTurn).toBeUndefined();
  });

  it("keeps the live orphan-repair heartbeat task active without parsing its marker", () => {
    const taskPrompt = "Check the deployment and report any failures.";
    const transcriptPrompt = "[OpenClaw heartbeat poll]";
    const mergedModelPrompt = [QUEUED_USER_MESSAGE_MARKER, transcriptPrompt, "", taskPrompt].join(
      "\n",
    );
    const fixture = createInput({
      attempt: createAttempt({ currentInboundContext: undefined }),
      prompt: createPrompt({
        effectivePrompt: mergedModelPrompt,
        promptBeforePromptBuildHooks: taskPrompt,
        effectiveTranscriptPrompt: transcriptPrompt,
        transcriptPromptForRuntimeSplit: transcriptPrompt,
        promptForRuntimeContextSplit: mergedModelPrompt,
        promptForModelBeforeRuntimeContextSplit: mergedModelPrompt,
        promptForRuntimeContextBeforeAnnotation: mergedModelPrompt,
      }),
    });

    const result = prepareEmbeddedAttemptPromptContext(fixture.input);

    expect(result.promptForSession).toBe(transcriptPrompt);
    expect(result.promptForModel).toBe(mergedModelPrompt);
    expect(result.promptSubmission.runtimeContext).toBeUndefined();
    expect(result.runtimeContextMessageForCurrentTurn).toBeUndefined();
  });

  it("still separates source context on a no-hook user turn", () => {
    const sourceContext = "Cross-session source: agent:research";
    const visiblePrompt = "Visible request";
    const fixture = createInput({
      attempt: createAttempt({ currentInboundContext: undefined }),
      prompt: createPrompt({
        effectivePrompt: visiblePrompt,
        promptBeforePromptBuildHooks: visiblePrompt,
        effectiveTranscriptPrompt: visiblePrompt,
        transcriptPromptForRuntimeSplit: visiblePrompt,
        promptForRuntimeContextSplit: `${sourceContext}\n\n${visiblePrompt}`,
        promptForModelBeforeRuntimeContextSplit: visiblePrompt,
        promptForRuntimeContextBeforeAnnotation: visiblePrompt,
      }),
    });

    const result = prepareEmbeddedAttemptPromptContext(fixture.input);

    expect(result.promptForSession).toBe(visiblePrompt);
    expect(result.promptForModel).toBe(visiblePrompt);
    expect(result.promptSubmission.runtimeContext).toBe(sourceContext);
    expect(result.runtimeContextMessageForCurrentTurn?.content).toContain(sourceContext);
  });
});
