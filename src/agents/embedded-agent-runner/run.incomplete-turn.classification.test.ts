// Focused incomplete-turn behavior coverage.
import { describe, expect, it } from "vitest";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  resolveEmptyResponseRetryInstruction,
  resolveReasoningOnlyRetryInstruction,
} from "./run/incomplete-turn-recovery.js";
import { resolveIncompleteTurnPayloadText } from "./run/incomplete-turn-resolution.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

const REASONING_ONLY_RETRY_INSTRUCTION =
  "The previous assistant turn recorded reasoning but did not produce a user-visible answer. Continue from that partial turn and produce the visible answer now. Do not restate the reasoning or restart from scratch.";
const EMPTY_RESPONSE_RETRY_INSTRUCTION =
  "The previous attempt did not produce a user-visible answer. Continue from the current state and produce the visible answer now. Do not restart from scratch.";

type LastAssistant = NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;

function makeLastAssistant(overrides: Record<string, unknown> = {}): LastAssistant {
  return { ...buildEmbeddedRunnerAssistant({}), ...overrides } as LastAssistant;
}

function makeReasoningRetryParams(
  attemptOverrides: Partial<EmbeddedRunAttemptResult> = {},
  overrides: Partial<
    Omit<Parameters<typeof resolveReasoningOnlyRetryInstruction>[0], "attempt">
  > = {},
): Parameters<typeof resolveReasoningOnlyRetryInstruction>[0] {
  return {
    provider: "openai",
    modelId: "gpt-5.6-luna",
    aborted: false,
    timedOut: false,
    attempt: makeEmbeddedRunnerAttempt(attemptOverrides),
    ...overrides,
  };
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

describe("incomplete-turn classification", () => {
  it("detects reasoning-only GPT turns from signed thinking blocks", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction(
      makeReasoningRetryParams({
        assistantTexts: [],
        lastAssistant: makeLastAssistant({
          stopReason: "end_turn",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_helper", type: "reasoning" }),
            },
          ],
        }),
      }),
    );

    expect(retryInstruction).toBe(REASONING_ONLY_RETRY_INSTRUCTION);
  });

  it("detects reasoning-only Gemini turns from signed thinking blocks", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction(
      makeReasoningRetryParams(
        {
          assistantTexts: [],
          lastAssistant: makeLastAssistant({
            stopReason: "end_turn",
            provider: "google",
            model: "gemini-2.5-pro",
            content: [
              {
                type: "thinking",
                thinking: "internal reasoning",
                thinkingSignature: JSON.stringify({ id: "gemini_rs_helper", type: "reasoning" }),
              },
            ],
          }),
        },
        { provider: "google", modelId: "gemini-2.5-pro" },
      ),
    );

    expect(retryInstruction).toBe(REASONING_ONLY_RETRY_INSTRUCTION);
  });

  it("retries signed reasoning-only Bedrock Converse turns with a visible-answer continuation", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction(
      makeReasoningRetryParams(
        {
          assistantTexts: [],
          lastAssistant: makeLastAssistant({
            provider: "amazon-bedrock",
            model: "openai.gpt-oss-120b-1:0",
            content: [
              {
                type: "thinking",
                thinking: "internal reasoning",
                thinkingSignature: "bedrock-reasoning-signature",
              },
            ],
          }),
        },
        {
          provider: "amazon-bedrock",
          modelId: "openai.gpt-oss-120b-1:0",
          modelApi: "bedrock-converse-stream",
        },
      ),
    );

    expect(retryInstruction).toBe(REASONING_ONLY_RETRY_INSTRUCTION);
  });

  it("retries signed reasoning-only Ollama turns with a visible-answer continuation instruction", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction(
      makeReasoningRetryParams(
        {
          assistantTexts: [],
          lastAssistant: makeLastAssistant({
            stopReason: "end_turn",
            provider: "ollama",
            model: "gemma4:31b",
            content: [
              {
                type: "thinking",
                thinking: "internal reasoning",
                thinkingSignature: JSON.stringify({ id: "ollama_rs_helper", type: "reasoning" }),
              },
            ],
          }),
        },
        { provider: "ollama", modelId: "gemma4:31b" },
      ),
    );

    expect(retryInstruction).toBe(REASONING_ONLY_RETRY_INSTRUCTION);
  });

  it("retries unsigned thinking-only turns via the reasoning-only path (openai-completions)", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction(
      makeReasoningRetryParams(
        {
          assistantTexts: [],
          lastAssistant: makeLastAssistant({
            model: "qwen3.6-35b-a3b",
            content: [
              {
                type: "thinking",
                thinking: "let me plan the tool calls I need to make...",
              },
            ],
          }),
        },
        { modelId: "qwen3.6-35b-a3b", modelApi: "openai-completions" },
      ),
    );

    expect(retryInstruction).toBe(REASONING_ONLY_RETRY_INSTRUCTION);
  });

  it("retries unsigned thinking-only Ollama turns via the reasoning-only path", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction(
      makeReasoningRetryParams(
        {
          assistantTexts: [],
          lastAssistant: makeLastAssistant({
            stopReason: "end_turn",
            provider: "ollama",
            model: "gemma4:31b",
            content: [
              {
                type: "thinking",
                thinking: "internal reasoning",
              },
            ],
          }),
        },
        { provider: "ollama", modelId: "gemma4:31b" },
      ),
    );

    expect(retryInstruction).toBe(REASONING_ONLY_RETRY_INSTRUCTION);
  });

  it("retries unsigned-thinking Ollama turns via the empty-response path", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction(
      makeEmptyResponseRetryParams(
        {
          assistantTexts: [],
          lastAssistant: makeLastAssistant({
            stopReason: "end_turn",
            provider: "ollama",
            model: "gemma4:31b",
            content: [
              {
                type: "thinking",
                thinking: "internal reasoning",
              },
            ],
          }),
        },
        { provider: "ollama", modelId: "gemma4:31b" },
      ),
    );

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("retries generic empty Ollama turns without visible text", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction(
      makeEmptyResponseRetryParams(
        {
          assistantTexts: [],
          lastAssistant: makeLastAssistant({
            stopReason: "end_turn",
            provider: "ollama",
            model: "gemma4:31b",
            content: [{ type: "text", text: "" }],
          }),
        },
        { provider: "ollama", modelId: "gemma4:31b" },
      ),
    );

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("retries empty Ollama stop turns when nonzero output tokens were generated", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction(
      makeEmptyResponseRetryParams(
        {
          assistantTexts: [],
          lastAssistant: makeLastAssistant({
            provider: "ollama",
            model: "minimax-m2.7:cloud",
            usage: { input: 100, output: 6, totalTokens: 106 },
          }),
        },
        { provider: "ollama", modelId: "minimax-m2.7:cloud" },
      ),
    );

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("does not retry empty turns after an accepted sessions_spawn delivery", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction(
      makeEmptyResponseRetryParams(
        {
          assistantTexts: [],
          acceptedSessionSpawns: [
            {
              runId: "run-child",
              childSessionKey: "agent:claude:subagent:child",
            },
          ],
          lastAssistant: makeLastAssistant({
            stopReason: "end_turn",
            provider: "ollama",
            model: "gemma4:31b",
            content: [{ type: "text", text: "" }],
          }),
        },
        { provider: "ollama", modelId: "gemma4:31b" },
      ),
    );

    expect(retryInstruction).toBeNull();
  });

  it("retries empty openai-chatgpt-responses turns with non-zero output tokens (#85364)", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction(
      makeEmptyResponseRetryParams(
        {
          assistantTexts: [],
          lastAssistant: makeLastAssistant({
            usage: { input: 24794, output: 111, cacheRead: 4608, totalTokens: 29513 },
          }),
        },
        { modelId: "gpt-5.5", modelApi: "openai-chatgpt-responses" },
      ),
    );

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("retries empty openai-responses turns without visible text", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction(
      makeEmptyResponseRetryParams(
        {
          assistantTexts: [],
          lastAssistant: makeLastAssistant({
            usage: { input: 5000, output: 200, totalTokens: 5200 },
          }),
        },
        { modelId: "gpt-5.5", modelApi: "openai-responses" },
      ),
    );

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("retries generic empty OpenAI-compatible turns from custom endpoints", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction(
      makeEmptyResponseRetryParams(
        {
          assistantTexts: [],
          lastAssistant: makeLastAssistant({
            provider: "llama-cpp-local",
            model: "qwen3.6-27b",
            usage: { input: 950, output: 103, totalTokens: 1053 },
          }),
        },
        {
          provider: "llama-cpp-local",
          modelId: "qwen3.6-27b",
          modelApi: "openai-completions",
        },
      ),
    );

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("does not retry clean zero-token Ollama stop turns", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction(
      makeEmptyResponseRetryParams(
        {
          assistantTexts: [],
          lastAssistant: makeLastAssistant({
            provider: "ollama",
            model: "glm-5.1:cloud",
            usage: { input: 100, output: 0, totalTokens: 100 },
          }),
        },
        { provider: "ollama", modelId: "glm-5.1:cloud" },
      ),
    );

    expect(retryInstruction).toBeNull();
  });

  it("treats exact NO_REPLY as a deliberate silent assistant reply", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams({
        assistantTexts: ["NO_REPLY"],
        lastAssistant: makeLastAssistant({
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_no_reply", type: "reasoning" }),
            },
            { type: "text", text: "" },
            { type: "text", text: "NO_REPLY" },
          ],
        }),
      }),
    );

    expect(incompleteTurnText).toBeNull();
  });
});
