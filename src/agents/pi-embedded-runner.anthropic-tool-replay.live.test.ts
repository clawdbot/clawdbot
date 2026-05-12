import type { Message, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  completeSimpleWithLiveTimeout,
  extractAssistantText,
  logLiveCache,
} from "./live-cache-test-support.js";
import { isLiveTestEnabled } from "./live-test-helpers.js";
import { wrapStreamFnSanitizeMalformedToolCalls } from "./pi-embedded-runner/run/attempt.tool-call-normalization.js";
import { OMITTED_ASSISTANT_REASONING_TEXT } from "./pi-embedded-runner/thinking.js";
import { buildAssistantMessageWithZeroUsage } from "./stream-message-shared.js";

const ANTHROPIC_LIVE = isLiveTestEnabled(["ANTHROPIC_LIVE_TEST"]);
const describeLive = ANTHROPIC_LIVE ? describe : describe.skip;
const ANTHROPIC_TIMEOUT_MS = 120_000;
const TOOL_OUTPUT_SENTINEL = "TOOL-RESULT-LIVE-MAGENTA";

function buildLiveAnthropicModel(): {
  apiKey: string;
  model: Model<"anthropic-messages">;
} {
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

describeLive("pi embedded anthropic replay sanitization (live)", () => {
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
        buildAssistantMessageWithZeroUsage({
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
        buildAssistantMessageWithZeroUsage({
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
          ...buildAssistantMessageWithZeroUsage({
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
