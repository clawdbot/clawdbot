import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { createOpenAICompletionsTransportStreamFn } from "../transports/openai-completions-transport.js";
import type { AssistantMessageEventStreamLike, Context, Model } from "../types.js";
import { streamOpenAICompletions } from "./openai-completions.js";

const model = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 0.5 },
  contextWindow: 128_000,
  maxTokens: 4_096,
} satisfies Model<"openai-completions">;

const context = {
  messages: [{ role: "user", content: "Explain the billing", timestamp: 1 }],
} satisfies Context;

type UsageScenario = {
  name: string;
  usage: Record<string, unknown>;
  expectedUsage: Record<string, unknown>;
  expectedCost?: number;
  inChoice?: boolean;
};

const scenarios: UsageScenario[] = [
  {
    name: "documented reasoning tokens and cache buckets",
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 25, cache_write_tokens: 10 },
      completion_tokens_details: { reasoning_tokens: 7 },
    },
    expectedUsage: {
      input: 65,
      output: 20,
      cacheRead: 25,
      cacheWrite: 10,
      reasoningTokens: 7,
      totalTokens: 120,
    },
    expectedCost: 0.00011625,
  },
  {
    name: "explicit zero reasoning tokens",
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      completion_tokens_details: { reasoning_tokens: 0 },
    },
    expectedUsage: { input: 10, output: 5, reasoningTokens: 0, totalTokens: 15 },
  },
  {
    name: "compatible prompt-cache-hit fallback",
    usage: {
      prompt_tokens: 100,
      prompt_cache_hit_tokens: 25,
      completion_tokens: 20,
      total_tokens: 120,
    },
    expectedUsage: { input: 75, output: 20, cacheRead: 25, cacheWrite: 0, totalTokens: 120 },
    expectedCost: 0.00012125,
  },
  {
    name: "compatible top-level cached tokens fallback",
    usage: {
      prompt_tokens: 177,
      completion_tokens: 5,
      total_tokens: 182,
      cached_tokens: 128,
    },
    expectedUsage: { input: 49, output: 5, cacheRead: 128, cacheWrite: 0, totalTokens: 182 },
  },
  {
    name: "authoritative provider-billed zero cost",
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 25, cache_write_tokens: 10 },
      cost: 0,
    },
    expectedUsage: {
      input: 65,
      output: 20,
      cacheRead: 25,
      cacheWrite: 10,
      totalTokens: 120,
      cost: { total: 0, totalOrigin: "provider-billed" },
    },
    expectedCost: 0,
  },
  {
    name: "invalid provider cost and cached-token overflow",
    usage: {
      prompt_tokens: 2,
      completion_tokens: 5,
      total_tokens: 7,
      prompt_tokens_details: { cached_tokens: 4 },
      cost: -1,
    },
    expectedUsage: { input: 0, output: 5, cacheRead: 4, cacheWrite: 0, totalTokens: 9 },
    expectedCost: 0.000011,
  },
  {
    name: "provider-compatible usage nested in a choice",
    usage: {
      prompt_tokens: 20,
      completion_tokens: 10,
      total_tokens: 30,
      prompt_tokens_details: { cached_tokens: 5 },
      completion_tokens_details: { reasoning_tokens: 3 },
    },
    expectedUsage: { input: 15, output: 10, cacheRead: 5, reasoningTokens: 3, totalTokens: 30 },
    inChoice: true,
  },
];

function installUsageChunk(scenario: UsageScenario): void {
  const choice = {
    index: 0,
    delta: { role: "assistant", content: "Usage preserved." },
    finish_reason: "stop",
    ...(scenario.inChoice ? { usage: scenario.usage } : {}),
  };
  const chunk = {
    id: `chatcmpl-${scenario.name.replaceAll(" ", "-")}`,
    object: "chat.completion.chunk",
    created: 1,
    model: model.id,
    choices: [choice],
    ...(scenario.inChoice ? {} : { usage: scenario.usage }),
  } as ChatCompletionChunk;
  const body = `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
  configureAiTransportHost({
    buildModelFetch: () => async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  });
}

const createManagedStream = createOpenAICompletionsTransportStreamFn();

function createManagedFixtureStream(): AssistantMessageEventStreamLike {
  const stream = createManagedStream(model, context, {
    apiKey: "fixture-token",
    reasoning: "medium",
  });
  if (stream instanceof Promise) {
    throw new Error("OpenAI Chat Completions transport must return its stream synchronously");
  }
  return stream;
}

let previousHost: ReturnType<typeof getAiTransportHost>;

beforeEach(() => {
  previousHost = getAiTransportHost();
});

afterEach(() => {
  configureAiTransportHost(previousHost);
});

describe.each([
  {
    name: "package",
    preservesReasoningTokens: false,
    createStream: () =>
      streamOpenAICompletions(model, context, {
        apiKey: "fixture-token",
        reasoningEffort: "medium",
      }),
  },
  { name: "managed", preservesReasoningTokens: true, createStream: createManagedFixtureStream },
])("$name Chat Completions usage", ({ createStream, preservesReasoningTokens }) => {
  it.each(scenarios)("preserves $name", async (scenario) => {
    installUsageChunk(scenario);
    const result = await createStream().result();
    const expectedUsage = { ...scenario.expectedUsage };
    if (!preservesReasoningTokens) {
      delete expectedUsage.reasoningTokens;
      expect(result.usage).not.toHaveProperty("reasoningTokens");
    }

    expect(result.stopReason).toBe("stop");
    expect(result.usage).toMatchObject(expectedUsage);
    if (scenario.expectedCost !== undefined) {
      expect(result.usage.cost.total).toBeCloseTo(scenario.expectedCost, 10);
    }
  });
});
