// Focused incomplete-turn behavior coverage.
import { describe, expect, it } from "vitest";
import { PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE } from "../../llm/types.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT,
  resolveEmptyResponseRetryInstruction,
  shouldRetrySilentErrorAssistantTurn,
  shouldTreatEmptyAssistantReplyAsSilent,
} from "./run/incomplete-turn-recovery.js";
import { resolveIncompleteTurnPayloadText } from "./run/incomplete-turn-resolution.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

const EMPTY_RESPONSE_RETRY_INSTRUCTION =
  "The previous attempt did not produce a user-visible answer. Continue from the current state and produce the visible answer now. Do not restart from scratch.";

type LastAssistant = NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;

function makeLastAssistant(overrides: Record<string, unknown> = {}): LastAssistant {
  return { ...buildEmbeddedRunnerAssistant({}), ...overrides } as LastAssistant;
}

function makeAttemptResult(
  overrides: Partial<EmbeddedRunAttemptResult> = {},
): EmbeddedRunAttemptResult {
  return makeEmbeddedRunnerAttempt(overrides);
}

function makeEmptyResponseRetryParams(
  attemptOverrides: Partial<EmbeddedRunAttemptResult> = {},
  overrides: Partial<
    Omit<Parameters<typeof resolveEmptyResponseRetryInstruction>[0], "attempt">
  > = {},
): Parameters<typeof resolveEmptyResponseRetryInstruction>[0] {
  return {
    provider: "openai",
    modelId: "gpt-5.6-luna",
    payloadCount: 0,
    aborted: false,
    timedOut: false,
    attempt: makeEmbeddedRunnerAttempt(attemptOverrides),
    ...overrides,
  };
}

function makeIncompleteTurnParams(
  attemptOverrides: Partial<EmbeddedRunAttemptResult> = {},
): Parameters<typeof resolveIncompleteTurnPayloadText>[0] {
  return {
    payloadCount: 0,
    aborted: false,
    externalAbort: false,
    timedOut: false,
    attempt: makeEmbeddedRunnerAttempt(attemptOverrides),
  };
}

function makeSilentReplyParams(
  attempt: EmbeddedRunAttemptResult,
  overrides: Partial<
    Omit<Parameters<typeof shouldTreatEmptyAssistantReplyAsSilent>[0], "attempt">
  > = {},
): Parameters<typeof shouldTreatEmptyAssistantReplyAsSilent>[0] {
  return {
    allowEmptyAssistantReplyAsSilent: true,
    payloadCount: 0,
    aborted: false,
    timedOut: false,
    attempt,
    ...overrides,
  };
}

describe("incomplete-turn error recovery", () => {
  it("retries replay-safe errored turns that only emitted thinking blocks", () => {
    const assistant = makeLastAssistant({
      stopReason: "error",
      provider: "anthropic",
      model: "claude-opus-4-8",
      content: [
        {
          type: "thinking",
          thinking: "internal reasoning before provider error",
          thinkingSignature: JSON.stringify({ id: "rs_error", type: "reasoning" }),
        },
        { type: "redacted_thinking", data: "opaque" },
        { type: "text", text: " " },
      ],
      usage: { input: 100, output: 1120, totalTokens: 1220 },
    });
    expect(
      shouldRetrySilentErrorAssistantTurn({
        attempt: makeAttemptResult({ assistantTexts: [], lastAssistant: assistant }),
        assistant,
      }),
    ).toBe(true);
  });

  it("does not retry an ambiguous post-dispatch provider outcome", () => {
    const assistant = makeLastAssistant({
      stopReason: "error",
      errorCode: PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE,
      errorMessage: "The WebSocket closed after dispatch",
      usage: { input: 100, output: 0, totalTokens: 100 },
    });
    expect(
      shouldRetrySilentErrorAssistantTurn({
        attempt: makeAttemptResult({ assistantTexts: [], lastAssistant: assistant }),
        assistant,
      }),
    ).toBe(false);
  });

  it("does not retry errored empty turns when non-zero output may indicate progress", () => {
    const assistant = makeLastAssistant({
      stopReason: "error",
      provider: "ollama",
      model: "glm-5.1:cloud",
      usage: { input: 100, output: 12, totalTokens: 112 },
    });
    expect(
      shouldRetrySilentErrorAssistantTurn({
        attempt: makeAttemptResult({ assistantTexts: [], lastAssistant: assistant }),
        assistant,
      }),
    ).toBe(false);
  });

  it.each([
    {
      name: "visible text",
      content: [
        { type: "thinking", thinking: "internal", thinkingSignature: "sig" },
        { type: "text", text: "partial answer" },
      ],
    },
    {
      name: "tool call",
      content: [
        { type: "thinking", thinking: "internal", thinkingSignature: "sig" },
        { type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } },
      ],
    },
    {
      name: "unknown block",
      content: [{ type: "provider_metadata", value: "opaque" }],
    },
  ])("does not retry errored turns containing $name", ({ content }) => {
    const assistant = makeLastAssistant({
      stopReason: "error",
      provider: "anthropic",
      model: "claude-opus-4-8",
      content,
      usage: { input: 100, output: 1120, totalTokens: 1220 },
    });
    expect(
      shouldRetrySilentErrorAssistantTurn({
        attempt: makeAttemptResult({ assistantTexts: [], lastAssistant: assistant }),
        assistant,
      }),
    ).toBe(false);
  });

  it("does not retry errored thinking-only turns after side effects", () => {
    const assistant = makeLastAssistant({
      stopReason: "error",
      provider: "anthropic",
      model: "claude-opus-4-8",
      content: [
        {
          type: "redacted_thinking",
          data: "opaque",
        },
      ],
      usage: { input: 100, output: 1120, totalTokens: 1220 },
    });
    expect(
      shouldRetrySilentErrorAssistantTurn({
        attempt: makeAttemptResult({
          assistantTexts: [],
          replayMetadata: {
            hadPotentialSideEffects: true,
            replaySafe: false,
          },
          lastAssistant: assistant,
        }),
        assistant,
      }),
    ).toBe(false);
  });

  it.each([
    ["current clean overrides cumulative dirty", true, false, true],
    ["current dirty overrides cumulative clean", false, true, false],
    ["both clean remain retryable", false, false, true],
  ] as const)(
    "uses current-attempt replay metadata when %s",
    (_label, cumulativeDirty, currentDirty, expected) => {
      const assistant = makeLastAssistant({
        stopReason: "error",
        provider: "openrouter",
        model: "test-model",
        usage: { input: 100, output: 0, totalTokens: 100 },
      });
      expect(
        shouldRetrySilentErrorAssistantTurn({
          attempt: makeAttemptResult({
            assistantTexts: [],
            lastAssistant: assistant,
            replayMetadata: {
              hadPotentialSideEffects: cumulativeDirty,
              replaySafe: !cumulativeDirty,
            },
            currentAttemptReplayMetadata: {
              hadPotentialSideEffects: currentDirty,
              replaySafe: !currentDirty,
            },
          }),
          assistant,
        }),
      ).toBe(expected);
    },
  );

  it("detects empty openai-compatible stop turns with non-zero output usage", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction(
      makeEmptyResponseRetryParams(
        {
          assistantTexts: [],
          lastAssistant: makeLastAssistant({
            provider: "llamacpp",
            model: "qwen3.6-27b",
            usage: { input: 512, output: 103, totalTokens: 615 },
          }),
        },
        { provider: "llamacpp", modelId: "qwen3.6-27b", modelApi: "openai-completions" },
      ),
    );

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("detects generic empty GPT turns without visible text", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction(
      makeEmptyResponseRetryParams({
        assistantTexts: [],
        lastAssistant: makeLastAssistant({
          stopReason: "end_turn",
          model: "gpt-5.4",
          content: [{ type: "text", text: "" }],
        }),
      }),
    );

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    expect(DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT).toBe(1);
  });

  it("surfaces empty Codex app-server replies after successful sparse bash output", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams({
        assistantTexts: [],
        toolMetas: [{ toolName: "bash", meta: "exit=0" }],
        messagesSnapshot: [
          {
            role: "toolResult",
            content: [{ type: "text", text: "" }],
            details: { aggregated: "" },
          } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
          makeLastAssistant({
            content: [{ type: "text", text: "" }],
          }),
        ],
        lastAssistant: makeLastAssistant({
          content: [{ type: "text", text: "" }],
        }),
      }),
    );

    expect(incompleteTurnText).toContain("couldn't generate a response");
    expect(incompleteTurnText).toContain("verify before retrying");
  });

  it("retries generic empty Bedrock Converse turns without visible text", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction(
      makeEmptyResponseRetryParams(
        {
          assistantTexts: [],
          lastAssistant: makeLastAssistant({
            provider: "amazon-bedrock",
            model: "openai.gpt-oss-120b-1:0",
            content: [{ type: "text", text: "" }],
            usage: { input: 950, output: 103, totalTokens: 1053 },
          }),
        },
        {
          provider: "amazon-bedrock",
          modelId: "openai.gpt-oss-120b-1:0",
          modelApi: "bedrock-converse-stream",
        },
      ),
    );

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("treats clean empty assistant turns as silent only for reply-optional runs", () => {
    const attempt = makeAttemptResult({
      assistantTexts: [],
      lastAssistant: makeLastAssistant({
        content: [{ type: "text", text: "" }],
      }),
    });

    expect(shouldTreatEmptyAssistantReplyAsSilent(makeSilentReplyParams(attempt))).toBe(false);
    expect(
      shouldTreatEmptyAssistantReplyAsSilent(
        makeSilentReplyParams(attempt, { terminalReplyExpectation: "optional" }),
      ),
    ).toBe(true);
    expect(
      shouldTreatEmptyAssistantReplyAsSilent(
        makeSilentReplyParams(attempt, { allowEmptyAssistantReplyAsSilent: false }),
      ),
    ).toBe(false);
  });

  it("treats reasoning-only assistant turns as silent only for reply-optional runs", () => {
    const attempt = makeAttemptResult({
      assistantTexts: [],
      lastAssistant: makeLastAssistant({
        stopReason: "end_turn",
        content: [
          {
            type: "thinking",
            thinking: "internal reasoning",
            thinkingSignature: JSON.stringify({ id: "rs_silent_helper", type: "reasoning" }),
          },
        ],
      }),
    });

    expect(shouldTreatEmptyAssistantReplyAsSilent(makeSilentReplyParams(attempt))).toBe(false);
    expect(
      shouldTreatEmptyAssistantReplyAsSilent(
        makeSilentReplyParams(attempt, { terminalReplyExpectation: "optional" }),
      ),
    ).toBe(true);
    expect(
      shouldTreatEmptyAssistantReplyAsSilent(
        makeSilentReplyParams(attempt, { allowEmptyAssistantReplyAsSilent: false }),
      ),
    ).toBe(false);
  });

  it("treats exact NO_REPLY assistant turns as silent only when the caller allows it", () => {
    const attempt = makeAttemptResult({
      assistantTexts: ["NO_REPLY"],
      lastAssistant: makeLastAssistant({
        content: [{ type: "text", text: "NO_REPLY" }],
      }),
    });

    expect(shouldTreatEmptyAssistantReplyAsSilent(makeSilentReplyParams(attempt))).toBe(true);
    expect(
      shouldTreatEmptyAssistantReplyAsSilent(
        makeSilentReplyParams(attempt, { allowEmptyAssistantReplyAsSilent: false }),
      ),
    ).toBe(false);
  });

  it("treats post-tool exact NO_REPLY assistant turns as intentional silence", () => {
    const attempt = makeAttemptResult({
      assistantTexts: ["NO_REPLY"],
      toolMetas: [{ toolName: "process.poll", meta: "pid=123", replaySafe: true }],
      lastAssistant: makeLastAssistant({
        content: [{ type: "text", text: "NO_REPLY" }],
      }),
    });

    expect(shouldTreatEmptyAssistantReplyAsSilent(makeSilentReplyParams(attempt))).toBe(true);
  });

  it("does not treat error or side-effect empty turns as silent", () => {
    const errorAttempt = makeAttemptResult({
      assistantTexts: [],
      lastAssistant: makeLastAssistant({
        stopReason: "error",
      }),
    });
    const silentErrorAttempt = makeAttemptResult({
      assistantTexts: ["NO_REPLY"],
      lastAssistant: makeLastAssistant({
        stopReason: "error",
        content: [{ type: "text", text: "NO_REPLY" }],
      }),
    });
    const sideEffectAttempt = makeAttemptResult({
      assistantTexts: [],
      didSendViaMessagingTool: true,
      messagingToolSentTexts: ["sent already"],
      lastAssistant: makeLastAssistant({
        content: [{ type: "text", text: "" }],
      }),
    });
    const postToolEmptyAttempt = makeAttemptResult({
      assistantTexts: [],
      toolMetas: [{ toolName: "process.poll", meta: "pid=123", replaySafe: true }],
      lastAssistant: makeLastAssistant({
        api: "openai-completions",
        provider: "stepfun",
        model: "step-router-v1",
      }),
    });

    expect(shouldTreatEmptyAssistantReplyAsSilent(makeSilentReplyParams(errorAttempt))).toBe(false);
    expect(shouldTreatEmptyAssistantReplyAsSilent(makeSilentReplyParams(silentErrorAttempt))).toBe(
      false,
    );
    expect(shouldTreatEmptyAssistantReplyAsSilent(makeSilentReplyParams(sideEffectAttempt))).toBe(
      false,
    );
    expect(
      shouldTreatEmptyAssistantReplyAsSilent(makeSilentReplyParams(postToolEmptyAttempt)),
    ).toBe(false);
  });
});
