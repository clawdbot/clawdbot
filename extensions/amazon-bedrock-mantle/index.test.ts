import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import bedrockMantlePlugin from "./index.js";

describe("amazon-bedrock-mantle provider plugin", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("registers with correct provider ID and label", async () => {
    const provider = await registerSingleProviderPlugin(bedrockMantlePlugin);
    expect(provider.id).toBe("amazon-bedrock-mantle");
    expect(provider.label).toBe("Amazon Bedrock Mantle (OpenAI-compatible)");
  });

  it("classifies rate limit errors for failover", async () => {
    const provider = await registerSingleProviderPlugin(bedrockMantlePlugin);
    expect(
      provider.classifyFailoverReason?.({ errorMessage: "rate_limit exceeded" } as never),
    ).toBe("rate_limit");
    expect(
      provider.classifyFailoverReason?.({ errorMessage: "429 Too Many Requests" } as never),
    ).toBe("rate_limit");
    expect(
      provider.classifyFailoverReason?.({ errorMessage: "some other error" } as never),
    ).toBeUndefined();
    expect(provider.classifyFailoverReason?.({ errorMessage: "overloaded_error" } as never)).toBe(
      "overloaded",
    );
  });

  it("provides a custom stream only for Mantle Anthropic models", async () => {
    const provider = await registerSingleProviderPlugin(bedrockMantlePlugin);

    expect(
      typeof provider.createStreamFn?.({
        provider: "amazon-bedrock-mantle",
        modelId: "anthropic.claude-opus-4-7",
        model: {
          api: "anthropic-messages",
        },
      } as never),
    ).toBe("function");

    expect(
      provider.createStreamFn?.({
        provider: "amazon-bedrock-mantle",
        modelId: "openai.gpt-oss-120b",
        model: {
          api: "openai-completions",
        },
      } as never),
    ).toBeUndefined();
  });
});
