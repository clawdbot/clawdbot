import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  createAnthropicGuard,
  createHostOpenAiGuard,
  createOpenAiGuard,
  type GuardAdapter,
} from "../protocol/index.js";
import type { ReefChannelConfig } from "./config-schema.js";
import { getReefRuntime } from "./runtime.js";

export function createConfiguredGuard(
  config: ReefChannelConfig,
  fetcher: typeof fetch = fetch,
): GuardAdapter {
  if (!config.guard) {
    throw new Error("Reef guard is not configured");
  }
  if (config.guard.authMode === "oauth") {
    const guard = config.guard;
    return createHostOpenAiGuard({
      pinnedModel: guard.pinnedModel,
      timeoutMs: guard.timeoutMs,
      rules: guard.rules,
      complete: async ({ systemPrompt, input, maxTokens, responseFormat, signal }) => {
        const result = await getReefRuntime().llm.complete({
          model: `openai/${guard.pinnedModel}@${guard.authProfileId}`,
          systemPrompt,
          messages: [{ role: "user", content: input }],
          maxTokens,
          responseFormat,
          // Reef only needs a small constrained classification verdict. Keep
          // reasoning explicit so reasoning-model defaults cannot consume the
          // entire guard deadline before emitting the JSON result.
          reasoning: "low",
          requiredAuthMode: "oauth",
          signal,
          purpose: "reef.guard",
        });
        return {
          text: result.text,
          provider: result.provider,
          model: result.model,
          responseModel: result.responseModel,
          stopReason: result.stopReason,
        };
      },
    });
  }
  const guardCredential = normalizeOptionalString(process.env[config.guard.apiKeyEnv]);
  if (!guardCredential) {
    throw new Error(
      `Reef guard credential environment variable ${config.guard.apiKeyEnv} is unset`,
    );
  }
  const options = {
    apiKey: guardCredential,
    pinnedModel: config.guard.pinnedModel,
    timeoutMs: config.guard.timeoutMs,
    rules: config.guard.rules,
    fetch: fetcher,
  };
  return config.guard.provider === "openai"
    ? createOpenAiGuard(options)
    : createAnthropicGuard(options);
}
