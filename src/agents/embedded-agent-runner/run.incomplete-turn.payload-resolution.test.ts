// Focused incomplete-turn behavior coverage.
import { beforeEach, describe, expect, it } from "vitest";
import {
  runEmbeddedAgent,
  makeLastAssistant,
  resolveIncompleteTurnPayloadText,
  makeRunParams,
  makeIncompleteTurnParams,
  expectWarnMessageWith,
  expectNoWarnMessageWith,
} from "./run.incomplete-turn.test-helpers.js";
import {
  mockedBuildEmbeddedRunPayloads,
  mockedClassifyFailoverReason,
  mockedRunEmbeddedAttempt,
  resetRunIncompleteTurnOwnerMocks,
} from "./run.incomplete-turn.test-support.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  resolveReplayInvalidFlag,
  shouldRetryMissingAssistantTurn,
} from "./run/incomplete-turn-resolution.js";
import { normalizeEmbeddedRunAttemptResult } from "./run/run-attempt-result.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

describe("runEmbeddedAgent incomplete-turn safety", () => {
  beforeEach(() => {
    resetRunIncompleteTurnOwnerMocks();
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
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams(
        {
          assistantTexts: ["Initial analysis of the codebase..."],
          toolMetas: [{ toolName: "read", meta: "path=src/index.ts" }],
          lastAssistant: makeLastAssistant({
            stopReason: "toolUse",
            provider: "anthropic",
            model: "sonnet-4.6",
            content: [
              { type: "text", text: "Initial analysis of the codebase..." },
              { type: "tool_use", id: "tool_1", name: "read", input: { path: "src/index.ts" } },
            ],
          }),
        },
        { payloadCount: 1 },
      ),
    );

    expect(incompleteTurnText).toContain("couldn't generate a response");
  });

  it("does not surface incomplete-turn error while an async media task is running", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams({
        assistantTexts: [],
        toolMetas: [
          {
            toolName: "image_generate",
            meta: 'generate prompt="a portrait"',
            asyncStarted: true,
          },
        ],
        lastAssistant: makeLastAssistant({
          stopReason: "toolUse",
          model: "gpt-5.4",
          content: [
            {
              type: "tool_use",
              id: "tool_1",
              name: "image_generate",
              input: { action: "generate", prompt: "a portrait" },
            },
          ],
        }),
      }),
    );

    expect(incompleteTurnText).toBeNull();
  });

  it("surfaces tool-use terminal with pre-tool text and side effects as replay-unsafe (#76477)", () => {
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
        },
        { payloadCount: 1 },
      ),
    );

    expect(incompleteTurnText).toContain("verify before retrying");
  });

  it("does not flag a completed tool-use turn with end_turn as incomplete (#76477)", () => {
    // When the model successfully produces post-tool text, lastAssistant has
    // stopReason=end_turn. The incomplete-turn guard should not fire.
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams(
        {
          assistantTexts: ["Initial analysis...", "Here is the final answer."],
          toolMetas: [{ toolName: "read" }],
          lastAssistant: makeLastAssistant({
            stopReason: "end_turn",
            provider: "anthropic",
            model: "sonnet-4.6",
            content: [{ type: "text", text: "Here is the final answer." }],
          }),
        },
        { payloadCount: 1 },
      ),
    );

    expect(incompleteTurnText).toBeNull();
  });

  it("surfaces stall on clean stop with only an unsigned thinking payload (payloadCount=1, no visible text)", () => {
    // Regression: unsigned thinking payloads increment payloadCount but carry no
    // user-visible content. The visible-text guard must not suppress incomplete-turn
    // detection when the model produced only a thinking block and no answer. (#89787)
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams(
        {
          assistantTexts: [],
          lastAssistant: makeLastAssistant({
            model: "qwen3.6-35b-a3b",
            content: [
              {
                type: "thinking",
                thinking: "let me plan the tool calls I need to make...",
                // no signature — unsigned thinking block
              },
            ],
          }),
        },
        { payloadCount: 1 },
      ),
    );

    expect(incompleteTurnText).toContain("couldn't generate a response");
  });

  it("does not surface a stall when unsigned thinking accompanies visible text (payloadCount=1)", () => {
    // When the model emits both a thinking block and a visible text answer, the turn
    // succeeded and no stall should be surfaced even though thinking is unsigned.
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams(
        {
          assistantTexts: ["Here is the answer to your question."],
          lastAssistant: makeLastAssistant({
            model: "qwen3.6-35b-a3b",
            content: [
              {
                type: "thinking",
                thinking: "let me answer this...",
              },
              { type: "text", text: "Here is the answer to your question." },
            ],
          }),
        },
        { payloadCount: 1 },
      ),
    );

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

    const result = await runEmbeddedAgent(
      makeRunParams("run-tool-use-dropped-final-text", {
        provider: "anthropic",
        model: "sonnet-4.6",
      }),
    );

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
        lastAssistant: makeLastAssistant({
          stopReason: "toolUse",
          content: [{ type: "tool_use", id: "tool_1", name: "update_plan", input: {} }],
          usage: { input: 100, output: 5, total: 105 },
        }),
        currentAttemptAssistant: makeLastAssistant({
          content: [{ type: "text", text: finalText }],
          usage: { input: 200, output: 20, total: 220 },
        }),
      }),
    );

    const result = await runEmbeddedAgent(makeRunParams("run-current-assistant-after-tool-use"));

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

    const normalizedAttempt = normalizeEmbeddedRunAttemptResult(attempt);

    expect(normalizedAttempt.replayMetadata).toEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
    expect(resolveReplayInvalidFlag({ attempt: normalizedAttempt })).toBe(true);
  });
});
