import type { Api, Model } from "@mariozechner/pi-ai";
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
    expect(deps.createClient).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: null,
        authToken: "bedrock-bearer-token",
        baseURL: "https://bedrock-mantle.us-east-1.api.aws/anthropic",
        defaultHeaders: expect.objectContaining({
          accept: "application/json",
          "anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
          "X-Test": "model-header",
          "X-Caller": "caller-header",
        }),
      }),
    );
    expect(deps.stream).toHaveBeenCalledWith(
      model,
      context,
      expect.objectContaining({
        client: expect.objectContaining({
          options: expect.objectContaining({
            authToken: "bedrock-bearer-token",
          }),
        }),
        thinkingEnabled: false,
      }),
    );
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

    expect(deps.stream).toHaveBeenCalledWith(
      model,
      context,
      expect.objectContaining({
        temperature: undefined,
        thinkingEnabled: false,
      }),
    );
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
