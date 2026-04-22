import { describe, expect, it } from "vitest";
import { shouldUseOpenAIWebSocketTransport } from "./attempt.thread-helpers.js";

describe("openai websocket transport selection", () => {
  it("accepts direct OpenAI Responses endpoints", () => {
    expect(
      shouldUseOpenAIWebSocketTransport({
        provider: "openai",
        modelApi: "openai-responses",
        modelBaseUrl: undefined,
      }),
    ).toBe(true);
    expect(
      shouldUseOpenAIWebSocketTransport({
        provider: "openai",
        modelApi: "openai-responses",
        modelBaseUrl: "https://api.openai.com/v1",
      }),
    ).toBe(true);
  });

  it("rejects non-public baseUrls even when the provider/api pair matches", () => {
    expect(
      shouldUseOpenAIWebSocketTransport({
        provider: "openai",
        modelApi: "openai-responses",
        modelBaseUrl: "http://127.0.0.1:4100/v1",
      }),
    ).toBe(false);
    expect(
      shouldUseOpenAIWebSocketTransport({
        provider: "openai",
        modelApi: "openai-responses",
        modelBaseUrl: "https://example.com/v1",
      }),
    ).toBe(false);
    expect(
      shouldUseOpenAIWebSocketTransport({
        provider: "openai",
        modelApi: "openai-responses",
        modelBaseUrl: "https://chatgpt.com/backend-api",
      }),
    ).toBe(false);
    expect(
      shouldUseOpenAIWebSocketTransport({
        provider: "openai",
        modelApi: "openai-responses",
        modelBaseUrl: "https://example.openai.azure.com/openai/v1",
      }),
    ).toBe(false);
  });

  it("rejects mismatched OpenAI websocket transport pairs", () => {
    expect(
      shouldUseOpenAIWebSocketTransport({
        provider: "openai",
        modelApi: "openai-codex-responses",
      }),
    ).toBe(false);
    expect(
      shouldUseOpenAIWebSocketTransport({
        provider: "openai-codex",
        modelApi: "openai-responses",
      }),
    ).toBe(false);
    expect(
      shouldUseOpenAIWebSocketTransport({
        provider: "openai-codex",
        modelApi: "openai-codex-responses",
      }),
    ).toBe(false);
    expect(
      shouldUseOpenAIWebSocketTransport({
        provider: "anthropic",
        modelApi: "openai-responses",
      }),
    ).toBe(false);
  });
});
