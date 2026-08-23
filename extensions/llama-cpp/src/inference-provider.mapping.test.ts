import type { Context } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import "./inference-provider.js";

const { mapContextToLlamaChatHistory, mapToolsToLlamaFunctions } = (
  globalThis as Record<PropertyKey, unknown>
)[Symbol.for("openclaw.llamaCppInferenceTestApi")] as {
  mapContextToLlamaChatHistory: (context: Context) => unknown[];
  mapToolsToLlamaFunctions: (context: Context) => Record<string, unknown> | undefined;
};

describe("llama.cpp inference mappings", () => {
  it("maps OpenClaw history and tool results into the model chat template history", () => {
    const context = {
      systemPrompt: "Be concise.",
      messages: [
        { role: "user" as const, content: "weather?", timestamp: 1 },
        {
          role: "assistant" as const,
          api: "openai-completions",
          provider: "test",
          model: "test",
          stopReason: "toolUse" as const,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          timestamp: 2,
          content: [
            { type: "text" as const, text: "Checking." },
            {
              type: "toolCall" as const,
              id: "call-1",
              name: "weather",
              arguments: { city: "Berlin" },
            },
          ],
        },
        {
          role: "toolResult" as const,
          toolCallId: "call-1",
          toolName: "weather",
          content: [{ type: "text" as const, text: "Sunny" }],
          isError: false,
          timestamp: 3,
        },
        { role: "user" as const, content: "thanks", timestamp: 4 },
      ],
    };

    expect(mapContextToLlamaChatHistory(context)).toEqual([
      { type: "system", text: "Be concise." },
      { type: "user", text: "weather?" },
      {
        type: "model",
        response: [
          "Checking.",
          {
            type: "functionCall",
            name: "weather",
            params: { city: "Berlin" },
            result: "Sunny",
          },
        ],
      },
      { type: "user", text: "thanks" },
    ]);
  });

  it("maps JSON-schema tools to native node-llama-cpp function definitions", () => {
    expect(
      mapToolsToLlamaFunctions({
        messages: [],
        tools: [
          {
            name: "weather",
            description: "Get weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        ],
      }),
    ).toEqual({
      weather: {
        description: "Get weather",
        params: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    });
  });
});
