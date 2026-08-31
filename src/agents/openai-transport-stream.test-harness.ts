// Verifies OpenAI-compatible streaming payloads, failures, and transport wrapping.
import type { MutableAssistantOutput } from "@openclaw/ai/transports";
import type { Api, Model } from "openclaw/plugin-sdk/llm";
import { expect } from "vitest";
import { testing } from "./openai-transport-stream.test-support.js";

export const buildOpenAIResponsesParams: typeof testing.buildOpenAIResponsesParams =
  testing.buildOpenAIResponsesParams;
export const resolveAzureOpenAIApiVersion: typeof testing.resolveAzureOpenAIApiVersion =
  testing.resolveAzureOpenAIApiVersion;

export type OpenAIResponsesOutput = Parameters<typeof testing.processResponsesStream>[1];

type ResponsesApi = Extract<
  Api,
  "openai-responses" | "openai-chatgpt-responses" | "azure-openai-responses"
>;

export type CapturedStreamEvent = {
  type?: string;
  contentIndex?: number;
  delta?: string;
  content?: string;
  partial?: unknown;
};

export function makeCompletionsModel(
  overrides: Partial<Model<"openai-completions">> = {},
): Model<"openai-completions"> {
  const id = overrides.id ?? "test-model";
  return {
    id,
    name: overrides.name ?? id,
    api: "openai-completions",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
    ...overrides,
  };
}

export function makeResponsesModel<TApi extends ResponsesApi = "openai-responses">(
  overrides: Partial<Model<TApi>> = {},
): Model<TApi> {
  const id = overrides.id ?? "test-model";
  return {
    id,
    name: overrides.name ?? id,
    api: "openai-responses" as TApi,
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
    ...overrides,
  } as Model<TApi>;
}

export function createAssistantOutput(model: Model<"openai-completions">): MutableAssistantOutput {
  return {
    role: "assistant" as const,
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
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
  };
}

export function createResponsesAssistantOutput(
  model: Model<"azure-openai-responses">,
): OpenAIResponsesOutput {
  return {
    role: "assistant" as const,
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
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
  };
}

export function createAzureResponsesModel(): Model<"azure-openai-responses"> {
  return makeResponsesModel({
    id: "gpt-5.4-pro",
    name: "GPT-5.4 Pro",
    api: "azure-openai-responses",
    provider: "azure-openai-responses-devdiv",
    baseUrl: "https://example.openai.azure.com/openai/responses",
  });
}

export function neverYieldsStream(): AsyncIterable<unknown> {
  // Simulates an HTTP stream that opened but never delivered the first SSE event.
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () => await new Promise<IteratorResult<unknown>>(() => {}),
        return: async () => ({ done: true, value: undefined }),
      };
    },
  };
}

export async function* streamChunks(chunks: readonly unknown[]): AsyncGenerator<never> {
  for (const chunk of chunks) {
    yield chunk as never;
  }
}

export function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  // Shared assertion helper for parsed transport payload/event records.
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}
