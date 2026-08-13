import { describe, expect, it } from "vitest";
import { classifyAssistantFailoverReason } from "./assistant-message-failures.js";

describe("classifyAssistantFailoverReason", () => {
  const opencodeGoStalledStreamError = {
    role: "assistant" as const,
    api: "openai-completions" as const,
    provider: "opencode-go",
    model: "deepseek-v4-flash",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error" as const,
    errorMessage: "opencode-go stream timed out after provider-owned SSE boundary stalled",
    content: [],
    timestamp: 0,
  };

  it("classifies opencode-go provider-owned stalled streams as timeout", () => {
    expect(classifyAssistantFailoverReason(opencodeGoStalledStreamError)).toBe("timeout");
  });

  it.each([
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_DNS_RESOLVE_FAILED",
    "UND_ERR_CONNECT",
    "UND_ERR_SOCKET",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
  ])("classifies structured %s assistant errors as timeouts", (errorCode) => {
    expect(
      classifyAssistantFailoverReason({
        ...opencodeGoStalledStreamError,
        provider: "demo-provider",
        errorCode,
        errorMessage: "provider connection closed",
      }),
    ).toBe("timeout");
  });

  it("does not classify caller-aborted assistant messages as provider failover", () => {
    expect(
      classifyAssistantFailoverReason({
        ...opencodeGoStalledStreamError,
        stopReason: "aborted",
      }),
    ).toBeNull();
  });

  it("uses structured assistant error bodies for model-not-found 400s", () => {
    expect(
      classifyAssistantFailoverReason({
        role: "assistant",
        api: "openai-completions",
        provider: "openai",
        model: "some-model-id",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage: "400 Param Incorrect",
        errorCode: "400",
        errorBody:
          '{"code":"400","message":"Param Incorrect","param":"Not supported model some-model-id"}',
        content: [],
        timestamp: 0,
      }),
    ).toBe("model_not_found");
  });
});
