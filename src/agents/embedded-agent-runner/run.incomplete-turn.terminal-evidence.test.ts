// Focused incomplete-turn behavior coverage.
import { beforeEach, describe, expect, it } from "vitest";
import {
  SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION,
  makeLastAssistant,
  resolveIncompleteTurnPayloadText,
  makeIncompleteTurnParams,
  makeSettledContinuationParams,
} from "./run.incomplete-turn.test-helpers.js";
import { resetRunIncompleteTurnOwnerMocks } from "./run.incomplete-turn.test-support.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import { isIncompleteTerminalAssistantTurn } from "./run/incomplete-turn-classification.js";
import { resolveSettledToolTerminalContinuationInstruction } from "./run/incomplete-turn-recovery.js";
import {
  resolveReplayInvalidFlag,
  resolveRunLivenessState,
} from "./run/incomplete-turn-resolution.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

describe("runEmbeddedAgent incomplete-turn safety", () => {
  beforeEach(() => {
    resetRunIncompleteTurnOwnerMocks();
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
});
