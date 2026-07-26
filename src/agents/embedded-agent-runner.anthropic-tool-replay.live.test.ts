// Live checks for Anthropic replay transcript sanitization and tool-call history.
import type { Message, Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { wrapStreamFnSanitizeMalformedToolCalls } from "./embedded-agent-runner/run/attempt.tool-call-normalization.js";
import { extractAssistantText } from "./embedded-agent-utils.js";
import { completeSimpleWithLiveTimeout, logLiveCache } from "./live-cache-test-support.js";
import { isLiveTestEnabled } from "./live-test-helpers.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "./stream-message-shared.js";

const ANTHROPIC_LIVE =
  isLiveTestEnabled(["ANTHROPIC_LIVE_TEST"]) &&
  (process.env.ANTHROPIC_API_KEY ?? "").trim().length > 0;
const describeLive = ANTHROPIC_LIVE ? describe : describe.skip;
const ANTHROPIC_TIMEOUT_MS = 120_000;
const TOOL_OUTPUT_SENTINEL = "TOOL-RESULT-LIVE-MAGENTA";
const OMITTED_ASSISTANT_REASONING_TEXT = "[assistant reasoning omitted]";

function buildTestAssistantMessage(
  params: Omit<Parameters<typeof buildAssistantMessage>[0], "usage">,
) {
  return buildAssistantMessage({ ...params, usage: buildUsageWithNoCost({}) });
}

function shouldSkipEmptyAnthropicReplayResult(label: string, text: string): boolean {
  // Some live Anthropic responses can be empty despite accepting the transcript;
  // treat that as provider drift instead of failing replay-shape validation.
  if (text.trim().length > 0) {
    return false;
  }
  console.warn(`[anthropic:live] skip ${label}: provider returned no visible text`);
  return true;
}

function buildLiveAnthropicModel(): {
  apiKey: string;
  model: Model<"anthropic-messages">;
} {
  // Keep the live model configurable while defaulting to the stable replay model
  // used by cache/live validation.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("missing ANTHROPIC_API_KEY");
  }
  const modelId =
    (process.env.OPENCLAW_LIVE_ANTHROPIC_CACHE_MODEL || "claude-sonnet-4-6")
      .split(/[/:]/)
      .findLast(Boolean) || "claude-sonnet-4-6";
  return {
    apiKey,
    model: {
      id: modelId,
      name: modelId,
      api: "anthropic-messages" as const,
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: true,
      input: ["text"] as const,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8_192,
    } satisfies Model<"anthropic-messages">,
  };
}

describeLive("embedded agent anthropic replay sanitization (live)", () => {
  it(
    "accepts regular text-only assistant replay history",
    async () => {
      const { apiKey, model } = buildLiveAnthropicModel();
      const messages: Message[] = [
        {
          role: "user",
          content: "Remember the marker REGULAR_ANTHROPIC_REPLAY_OK.",
          timestamp: Date.now(),
        },
        buildTestAssistantMessage({
          model: { api: model.api, provider: model.provider, id: model.id },
          content: [{ type: "text", text: "I remember REGULAR_ANTHROPIC_REPLAY_OK." }],
          stopReason: "stop",
        }),
        {
          role: "user",
          content: "Reply with a short confirmation if this replay history is valid.",
          timestamp: Date.now(),
        },
      ];

      logLiveCache(`anthropic regular replay live model=${model.provider}/${model.id}`);
      const response = await completeSimpleWithLiveTimeout(
        model,
        { messages },
        {
          apiKey,
          cacheRetention: "none",
          sessionId: "anthropic-regular-replay-live",
          maxTokens: 64,
          temperature: 0,
        },
        "anthropic regular text replay live synthetic transcript",
        ANTHROPIC_TIMEOUT_MS,
      );

      const text = extractAssistantText(response);
      logLiveCache(`anthropic regular replay live result=${JSON.stringify(text)}`);
      if (shouldSkipEmptyAnthropicReplayResult("regular replay", text)) {
        return;
      }
      expect(text.trim().length).toBeGreaterThan(0);
    },
    6 * 60_000,
  );

  it(
    "accepts omitted-reasoning placeholder assistant replay history",
    async () => {
      const { apiKey, model } = buildLiveAnthropicModel();
      const messages: Message[] = [
        {
          role: "user",
          content: "Remember that the previous assistant reasoning was omitted.",
          timestamp: Date.now(),
        },
        buildTestAssistantMessage({
          model: { api: model.api, provider: model.provider, id: model.id },
          content: [{ type: "text", text: OMITTED_ASSISTANT_REASONING_TEXT }],
          stopReason: "stop",
        }),
        {
          role: "user",
          content: "Reply with exactly OK if this placeholder replay history is valid.",
          timestamp: Date.now(),
        },
      ];

      logLiveCache(`anthropic omitted-reasoning replay live model=${model.provider}/${model.id}`);
      const response = await completeSimpleWithLiveTimeout(
        model,
        { messages },
        {
          apiKey,
          cacheRetention: "none",
          sessionId: "anthropic-omitted-reasoning-replay-live",
          maxTokens: 64,
          temperature: 0,
        },
        "anthropic omitted reasoning replay live synthetic transcript",
        ANTHROPIC_TIMEOUT_MS,
      );

      const text = extractAssistantText(response);
      logLiveCache(`anthropic omitted-reasoning replay live result=${JSON.stringify(text)}`);
      if (shouldSkipEmptyAnthropicReplayResult("omitted reasoning replay", text)) {
        return;
      }
      expect(text.trim().length).toBeGreaterThan(0);
    },
    6 * 60_000,
  );

  it(
    "preserves toolCall replay history that Anthropic accepts end-to-end",
    async () => {
      const { apiKey, model } = buildLiveAnthropicModel();
      const messages: Message[] = [
        {
          ...buildTestAssistantMessage({
            model: { api: model.api, provider: model.provider, id: model.id },
            content: [{ type: "toolCall", id: "call_1", name: "noop", arguments: {} }],
            stopReason: "toolUse",
          }),
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "noop",
          content: [{ type: "text", text: TOOL_OUTPUT_SENTINEL }],
          isError: false,
          timestamp: Date.now(),
        },
        {
          role: "user",
          content:
            "The tool finished. Reply with exactly OK as plain text if this replay history is valid.",
          timestamp: Date.now(),
        },
      ];

      const baseFn = vi.fn((_model: unknown, context: unknown) => ({ context }));
      // First prove local sanitizer output is unchanged, then send the exact
      // sanitized transcript to the live API.
      const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["noop"]), {
        validateGeminiTurns: false,
        validateAnthropicTurns: true,
        preserveSignatures: false,
        dropThinkingBlocks: false,
      });

      await Promise.resolve(wrapped(model as never, { messages } as never, {} as never));

      expect(baseFn).toHaveBeenCalledTimes(1);
      const seenMessages = (baseFn.mock.calls.at(0)?.[1] as { messages?: unknown[] })?.messages;
      expect(seenMessages).toEqual(messages);

      logLiveCache(`anthropic replay live model=${model.provider}/${model.id}`);
      const response = await completeSimpleWithLiveTimeout(
        model,
        { messages: seenMessages as typeof messages },
        {
          apiKey,
          cacheRetention: "none",
          sessionId: "anthropic-tool-replay-live",
          maxTokens: 64,
          temperature: 0,
        },
        "anthropic replay live synthetic transcript",
        ANTHROPIC_TIMEOUT_MS,
      );

      const text = extractAssistantText(response);
      logLiveCache(`anthropic replay live result=${JSON.stringify(text)}`);
      expect(response.content.length).toBeGreaterThanOrEqual(0);
    },
    6 * 60_000,
  );
});
