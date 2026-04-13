import { describe, expect, it } from "vitest";
import { resolveMissingProviderApiKey } from "./models-config.providers.secret-helpers.js";

describe("models-config", () => {
  it("fills missing provider.apiKey from env var name when models exist", () => {
    const provider = resolveMissingProviderApiKey({
      providerKey: "minimax",
      provider: {
        baseUrl: "https://api.minimax.io/anthropic",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.7",
            name: "MiniMax M2.7",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
      env: { MINIMAX_API_KEY: "sk-minimax-test" } as NodeJS.ProcessEnv,
      profileApiKey: undefined,
    });

    expect(provider.apiKey).toBe("MINIMAX_API_KEY"); // pragma: allowlist secret
  });
});
