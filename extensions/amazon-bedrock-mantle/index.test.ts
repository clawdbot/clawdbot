import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import bedrockMantlePlugin from "./index.js";

describe("amazon-bedrock-mantle provider plugin", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("uses live plugin config to disable catalog discovery", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected fetch"));
    const provider = await registerSingleProviderPlugin(bedrockMantlePlugin);
    const catalog = provider.catalog;
    if (!catalog) {
      throw new Error("catalog registration missing");
    }

    const result = await catalog.run({
      config: {
        plugins: {
          entries: {
            "amazon-bedrock-mantle": {
              config: {
                discovery: { enabled: false },
              },
            },
          },
        },
      },
      env: {
        AWS_BEARER_TOKEN_BEDROCK: "test-token",
        AWS_REGION: "us-east-1",
      },
    } as never);

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
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
