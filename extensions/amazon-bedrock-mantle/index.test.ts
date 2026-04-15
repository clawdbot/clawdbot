import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import bedrockMantlePlugin from "./index.js";

describe("amazon-bedrock-mantle provider plugin", () => {
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
  });
});
