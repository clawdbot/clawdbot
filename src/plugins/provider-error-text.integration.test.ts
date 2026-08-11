import { describe, expect, it } from "vitest";
import { formatAssistantErrorText } from "../agents/embedded-agent-helpers/error-text.js";
import { formatBillingErrorMessage } from "../agents/failover/user-copy.js";
import { makeAssistantMessageFixture } from "../agents/test-helpers/assistant-message-fixtures.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveProviderRuntimePlugin } from "./provider-runtime.js";

describe("provider-owned terminal error formatting", () => {
  it("uses resolved OpenRouter ownership for a custom-provider billing error", () => {
    const provider = "custom-openrouter";
    const model = "anthropic/claude-sonnet-4";
    const config = {
      models: {
        providers: {
          [provider]: {
            api: "openai-completions",
            baseUrl: "https://openrouter.ai/api/v1",
            models: [
              {
                id: model,
                name: model,
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 16_000,
                maxTokens: 1_024,
              },
            ],
          },
        },
      },
    } satisfies OpenClawConfig;
    const owner = resolveProviderRuntimePlugin({
      provider,
      providerOwner: "openrouter",
      modelId: model,
      config,
    });
    expect(owner?.id).toBe("openrouter");

    const billing = makeAssistantMessageFixture({
      provider,
      model,
      errorMessage: "HTTP 403: API key budget limit exceeded",
    });
    expect(
      formatAssistantErrorText(billing, {
        provider,
        providerOwner: owner,
        model,
      }),
    ).toBe(formatBillingErrorMessage(provider, model));
  });
});
