// Focused incomplete-turn behavior coverage.
import { describe, expect, it } from "vitest";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  resolveIncompleteTurnPayloadText,
  shouldRetryMissingAssistantTurn,
} from "./run/incomplete-turn-resolution.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

type LastAssistant = NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;

function makeLastAssistant(overrides: Record<string, unknown> = {}): LastAssistant {
  return { ...buildEmbeddedRunnerAssistant({}), ...overrides } as LastAssistant;
}

function makeAttemptResult(
  overrides: Partial<EmbeddedRunAttemptResult> = {},
): EmbeddedRunAttemptResult {
  return makeEmbeddedRunnerAttempt(overrides);
}

function makeIncompleteTurnParams(
  attemptOverrides: Partial<EmbeddedRunAttemptResult> = {},
  overrides: Partial<Omit<Parameters<typeof resolveIncompleteTurnPayloadText>[0], "attempt">> = {},
): Parameters<typeof resolveIncompleteTurnPayloadText>[0] {
  return {
    payloadCount: 0,
    aborted: false,
    externalAbort: false,
    timedOut: false,
    attempt: makeEmbeddedRunnerAttempt(attemptOverrides),
    ...overrides,
  };
}

describe("incomplete-turn payload resolution", () => {
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
      externalAbort: false,
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
});
