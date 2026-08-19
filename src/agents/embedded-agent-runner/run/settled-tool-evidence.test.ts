// Focused incomplete-turn behavior coverage.
import { describe, expect, it } from "vitest";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { isIncompleteTerminalAssistantTurn } from "./incomplete-turn-classification.js";
import { resolveSettledToolTerminalContinuationInstruction } from "./incomplete-turn-recovery.js";
import { resolveReplayInvalidFlag, resolveRunLivenessState } from "./incomplete-turn-resolution.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

const SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION =
  "The previous assistant turn completed its tool calls but did not produce a user-visible answer. Continue from the current transcript and produce the final user-visible answer now. Do not repeat completed tool calls or restart from scratch.";

type LastAssistant = NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;

function makeLastAssistant(overrides: Partial<LastAssistant> = {}): LastAssistant {
  return { ...buildEmbeddedRunnerAssistant({}), ...overrides } as LastAssistant;
}

function makeAttemptResult(
  overrides: Partial<EmbeddedRunAttemptResult> = {},
): EmbeddedRunAttemptResult {
  return makeEmbeddedRunnerAttempt(overrides);
}

function makeSettledContinuationParams(
  attemptOverrides: Partial<EmbeddedRunAttemptResult> = {},
  overrides: Partial<
    Omit<Parameters<typeof resolveSettledToolTerminalContinuationInstruction>[0], "attempt">
  > = {},
): Parameters<typeof resolveSettledToolTerminalContinuationInstruction>[0] {
  return {
    provider: "openai",
    modelId: "gpt-5.6-luna",
    modelApi: "openai-responses",
    payloadCount: 0,
    aborted: false,
    timedOut: false,
    attempt: makeEmbeddedRunnerAttempt(attemptOverrides),
    ...overrides,
  };
}

function makeSettledIdleWriteAttempt(options?: {
  terminal?: EmbeddedRunAttemptResult["terminal"];
  stalePriorTurn?: boolean;
}) {
  const toolUseAssistant = makeLastAssistant({
    stopReason: "toolUse",
    content: [{ type: "toolCall", id: "tool_1", name: "write", arguments: {} }],
  });
  const abortedAssistant = makeLastAssistant({ stopReason: "aborted", content: [] });
  return makeAttemptResult({
    terminal: options?.terminal ?? { kind: "timeout", phase: "prompt", source: "idle" },
    assistantTexts: [],
    toolMetas: [{ toolName: "write", replaySafe: false }],
    itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
    messagesSnapshot: [
      { role: "user", content: [{ type: "text", text: "old turn" }] },
      toolUseAssistant,
      { role: "toolResult", toolCallId: "tool_1", toolName: "write", isError: false },
      ...(options?.stalePriorTurn
        ? [{ role: "user", content: [{ type: "text", text: "current turn" }] }]
        : []),
      abortedAssistant,
    ] as unknown as EmbeddedRunAttemptResult["messagesSnapshot"],
    lastAssistant: abortedAssistant,
    currentAttemptAssistant: abortedAssistant,
    currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
  });
}

describe("runEmbeddedAgent incomplete-turn safety", () => {
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
    ).toBe(false);
    expect(
      isIncompleteTerminalAssistantTurn({
        hasAssistantVisibleText: false,
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

  it("continues an exactly settled current-turn tool batch after an idle prompt timeout", () => {
    const instruction = resolveSettledToolTerminalContinuationInstruction(
      makeSettledContinuationParams(makeSettledIdleWriteAttempt(), {
        timedOut: true,
      }),
    );

    expect(instruction).toBe(SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION);
  });

  it.each([
    {
      label: "provider failure with finalization context",
      hasContext: true,
      expectedContinuation: true,
    },
    {
      label: "provider failure without finalization context",
      hasContext: false,
      expectedContinuation: false,
    },
  ])(
    "$label after settled tools returns continuation=$expectedContinuation",
    ({ hasContext, expectedContinuation }) => {
      const attempt = makeSettledIdleWriteAttempt({
        terminal: { kind: "failed", source: "prompt", error: new Error("provider failure") },
      });
      const instruction = resolveSettledToolTerminalContinuationInstruction(
        makeSettledContinuationParams(
          hasContext
            ? {
                ...attempt,
                settledTurnFinalizationContext: {
                  source: "openclaw-transcript",
                  messages: attempt.messagesSnapshot,
                },
              }
            : attempt,
        ),
      );

      expect(instruction === SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION).toBe(
        expectedContinuation,
      );
    },
  );

  it.each([
    {
      label: "external abort",
      terminal: { kind: "timeout", phase: "prompt", source: "external" } as const,
      aborted: true,
      timedOut: true,
    },
    {
      label: "runtime timeout",
      terminal: { kind: "timeout", phase: "prompt", source: "runtime" } as const,
      aborted: false,
      timedOut: true,
    },
    {
      label: "run budget timeout",
      terminal: { kind: "timeout", phase: "prompt", source: "run_budget" } as const,
      aborted: false,
      timedOut: true,
    },
    {
      label: "compaction timeout",
      terminal: { kind: "timeout", phase: "compaction", source: "idle" } as const,
      aborted: false,
      timedOut: true,
    },
    {
      label: "tool execution timeout",
      terminal: { kind: "timeout", phase: "tool_execution", source: "idle" } as const,
      aborted: false,
      timedOut: true,
    },
    {
      label: "timeout observation",
      terminal: { kind: "timeout", phase: "tool_execution", source: "observation" } as const,
      aborted: false,
      timedOut: false,
    },
  ])("does not finalize settled tools after a $label", ({ terminal, aborted, timedOut }) => {
    const instruction = resolveSettledToolTerminalContinuationInstruction(
      makeSettledContinuationParams(makeSettledIdleWriteAttempt({ terminal }), {
        aborted,
        timedOut,
      }),
    );

    expect(instruction).toBeNull();
  });

  it("does not use a settled prior-turn batch to authorize idle-timeout finalization", () => {
    const instruction = resolveSettledToolTerminalContinuationInstruction(
      makeSettledContinuationParams(makeSettledIdleWriteAttempt({ stalePriorTurn: true }), {
        timedOut: true,
      }),
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
      expect(instruction).toContain("If a tool failed, say so; never claim completion or success.");
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
});
