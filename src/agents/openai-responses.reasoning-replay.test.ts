import type {
  AssistantMessage,
  Model,
  ToolResultMessage,
} from "@mariozechner/pi-ai";
import { streamOpenAIResponses } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

function buildModel(): Model<"openai-responses"> {
  return {
    id: "gpt-5.2",
    name: "gpt-5.2",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  };
}

function installFailingFetchCapture() {
  const originalFetch = globalThis.fetch;
  let lastBody: unknown;

  const fetchImpl: typeof fetch = async (_input, init) => {
    const rawBody = init?.body;
    const bodyText = (() => {
      if (!rawBody) return "";
      if (typeof rawBody === "string") return rawBody;
      if (rawBody instanceof Uint8Array)
        return Buffer.from(rawBody).toString("utf8");
      if (rawBody instanceof ArrayBuffer)
        return Buffer.from(new Uint8Array(rawBody)).toString("utf8");
      return String(rawBody);
    })();
    lastBody = bodyText ? (JSON.parse(bodyText) as unknown) : undefined;
    throw new Error("intentional fetch abort (test)");
  };

  globalThis.fetch = fetchImpl;

  return {
    getLastBody: () => lastBody as Record<string, unknown> | undefined,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

describe("openai-responses reasoning replay", () => {
  it("handles tool-call-only turns without requiring reasoning replay", async () => {
    const cap = installFailingFetchCapture();
    try {
      const model = buildModel();

      const assistantToolOnly: AssistantMessage = {
        role: "assistant",
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.2",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: Date.now(),
        content: [
          {
            type: "thinking",
            thinking: "internal",
            thinkingSignature: JSON.stringify({
              type: "reasoning",
              id: "rs_test",
              summary: [],
            }),
          },
          {
            type: "toolCall",
            id: "call_123|fc_123",
            name: "noop",
            arguments: {},
          },
        ],
      };

      const toolResult: ToolResultMessage = {
        role: "toolResult",
        toolCallId: "call_123|fc_123",
        toolName: "noop",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: Date.now(),
      };

      const stream = streamOpenAIResponses(
        model,
        {
          systemPrompt: "system",
          messages: [
            {
              role: "user",
              content: "Call noop.",
              timestamp: Date.now(),
            },
            assistantToolOnly,
            toolResult,
            {
              role: "user",
              content: "Now reply with ok.",
              timestamp: Date.now(),
            },
          ],
          tools: [
            {
              name: "noop",
              description: "no-op",
              parameters: Type.Object({}, { additionalProperties: false }),
            },
          ],
        },
        { apiKey: "test" },
      );

      await stream.result();

      const body = cap.getLastBody();
      const input = Array.isArray(body?.input) ? body?.input : [];
      const types = input
        .map((item) =>
          item && typeof item === "object"
            ? (item as Record<string, unknown>).type
            : undefined,
        )
        .filter((t): t is string => typeof t === "string");

      expect(types).toContain("function_call");
      const reasoningIndex = types.indexOf("reasoning");
      if (reasoningIndex !== -1) {
        expect(reasoningIndex).toBeLessThan(types.indexOf("function_call"));
      }
    } finally {
      cap.restore();
    }
  });

  it("still replays reasoning when paired with an assistant message", async () => {
    const cap = installFailingFetchCapture();
    try {
      const model = buildModel();

      const assistantWithText: AssistantMessage = {
        role: "assistant",
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.2",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
        content: [
          {
            type: "thinking",
            thinking: "internal",
            thinkingSignature: JSON.stringify({
              type: "reasoning",
              id: "rs_test",
              summary: [],
            }),
          },
          { type: "text", text: "hello", textSignature: "msg_test" },
        ],
      };

      const stream = streamOpenAIResponses(
        model,
        {
          systemPrompt: "system",
          messages: [
            { role: "user", content: "Hi", timestamp: Date.now() },
            assistantWithText,
            { role: "user", content: "Ok", timestamp: Date.now() },
          ],
        },
        { apiKey: "test" },
      );

      await stream.result();

      const body = cap.getLastBody();
      const input = Array.isArray(body?.input) ? body?.input : [];
      const types = input
        .map((item) =>
          item && typeof item === "object"
            ? (item as Record<string, unknown>).type
            : undefined,
        )
        .filter((t): t is string => typeof t === "string");

      expect(types).toContain("reasoning");
      expect(types).toContain("message");
    } finally {
      cap.restore();
    }
  });
});
