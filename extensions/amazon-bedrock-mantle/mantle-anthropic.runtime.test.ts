import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  createMantleAnthropicStreamFn,
  resolveMantleAnthropicBaseUrl,
} from "./mantle-anthropic.runtime.js";

function createTestModel(): Model<Api> {
  return {
    id: "anthropic.claude-opus-4-7",
    name: "Claude Opus 4.7",
    provider: "amazon-bedrock-mantle",
    api: "anthropic-messages",
    baseUrl: "https://bedrock-mantle.us-east-1.api.aws/v1",
    headers: {
      "X-Test": "model-header",
    },
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  } as Model<Api>;
}

function createTestDeps() {
  return {
    createClient: vi.fn((options: unknown) => ({ options }) as never),
    stream: vi.fn(),
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

describe("createMantleAnthropicStreamFn", () => {
  it("uses authToken bearer auth for Mantle Anthropic requests", () => {
    const stream = { kind: "anthropic-stream" };
    const model = createTestModel();
    const context = { messages: [] };
    const deps = createTestDeps();
    deps.stream.mockReturnValue(stream as never);

    const result = createMantleAnthropicStreamFn(deps)(model, context, {
      apiKey: "bedrock-bearer-token",
      headers: {
        "X-Caller": "caller-header",
      },
    });

    expect(result).toBe(stream);
    const clientOptions = requireRecord(deps.createClient.mock.calls[0]?.[0], "client options");
    expect(clientOptions.apiKey).toBeNull();
    expect(clientOptions.authToken).toBe("bedrock-bearer-token");
    expect(clientOptions.baseURL).toBe("https://bedrock-mantle.us-east-1.api.aws/anthropic");
    const defaultHeaders = requireRecord(clientOptions.defaultHeaders, "default headers");
    expect(defaultHeaders.accept).toBe("application/json");
    expect(defaultHeaders["anthropic-beta"]).toBe("fine-grained-tool-streaming-2025-05-14");
    expect(defaultHeaders["X-Test"]).toBe("model-header");
    expect(defaultHeaders["X-Caller"]).toBe("caller-header");

    expect(deps.stream.mock.calls[0]?.[0]).toBe(model);
    expect(deps.stream.mock.calls[0]?.[1]).toBe(context);
    const streamOptions = requireRecord(deps.stream.mock.calls[0]?.[2], "stream options");
    const client = requireRecord(streamOptions.client, "stream client");
    expect(requireRecord(client.options, "stream client options").authToken).toBe(
      "bedrock-bearer-token",
    );
    expect(streamOptions.thinkingEnabled).toBe(false);
  });

  it("omits unsupported Opus 4.7 sampling and reasoning overrides", () => {
    const model = createTestModel();
    const context = { messages: [] };
    const deps = createTestDeps();
    deps.stream.mockReturnValue({ kind: "anthropic-stream" } as never);

    void createMantleAnthropicStreamFn(deps)(model, context, {
      apiKey: "bedrock-bearer-token",
      temperature: 0.2,
      reasoning: "high",
    });

    expect(deps.stream.mock.calls[0]?.[0]).toBe(model);
    expect(deps.stream.mock.calls[0]?.[1]).toBe(context);
    const streamOptions = requireRecord(deps.stream.mock.calls[0]?.[2], "stream options");
    expect(streamOptions.temperature).toBeUndefined();
    expect(streamOptions.thinkingEnabled).toBe(false);
  });

  it("normalizes Mantle provider URLs to the Anthropic endpoint", () => {
    expect(resolveMantleAnthropicBaseUrl("https://bedrock-mantle.us-east-1.api.aws/v1")).toBe(
      "https://bedrock-mantle.us-east-1.api.aws/anthropic",
    );
    expect(
      resolveMantleAnthropicBaseUrl("https://bedrock-mantle.us-east-1.api.aws/anthropic/"),
    ).toBe("https://bedrock-mantle.us-east-1.api.aws/anthropic");
  });
});
