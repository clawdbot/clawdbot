import { expect, it } from "vitest";
import type { Context, Model } from "../llm/types.js";
import { transformTransportMessages } from "./transport-message-transform.js";

it.each([
  { id: "gpt-5.6-luna", provider: "openai", api: "openai-responses" },
  { id: "gpt-5.6-luna", provider: "openai", api: "openai-completions" },
  { id: "claude-sonnet-4-6", provider: "anthropic", api: "anthropic-messages" },
])("pairs an async source result before replaying on $api/$id", (target) => {
  const model: Model = {
    ...target,
    name: target.id,
    baseUrl: "https://example.test",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 1000,
  };
  const assistant = {
    role: "assistant" as const,
    provider: "openai",
    model: "async-model",
    api: "openai-responses",
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  const messages: Context["messages"] = [
    {
      ...assistant,
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "lookup", name: "lookup", arguments: {}, async: true }],
    },
    { ...assistant, stopReason: "stop", content: [{ type: "text", text: "independent answer" }] },
    {
      role: "toolResult",
      toolCallId: "lookup",
      toolName: "lookup",
      content: [{ type: "text", text: "found" }],
      isError: false,
      timestamp: 1,
    },
  ];
  const replay = transformTransportMessages(messages, model);
  expect(replay.map((message) => message.role)).toEqual(["assistant", "toolResult", "assistant"]);
  expect(replay[0]?.content[0]).not.toHaveProperty("async");
  expect(replay[1]).toMatchObject({ isError: false, content: [{ type: "text", text: "found" }] });
  expect(messages[0]?.content[0]).toHaveProperty("async", true);
});
