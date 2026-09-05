import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createAnthropicGuard, createOpenAiGuard, type GuardAdapter } from "../protocol/index.js";
import { ReefChannelConfigSchema, type ReefChannelConfig } from "./config-schema.js";

export async function createConfiguredGuard(
  config: ReefChannelConfig,
  fetcher: typeof fetch = fetch,
  rootConfig: OpenClawConfig = {},
): Promise<GuardAdapter> {
  // Do not expose validation inputs (which may contain a literal credential).
  const parsed = ReefChannelConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(
      "Invalid Reef guard configuration; check endpoint, credential source, and provider options",
    );
  }
  const guard = parsed.data.guard;
  if (!guard) {
    throw new Error("Reef guard is not configured");
  }
  let apiKey: string | undefined;
  if (guard.apiKeyEnv !== undefined) {
    apiKey = normalizeOptionalString(process.env[guard.apiKeyEnv]);
    if (!apiKey) {
      throw new Error(`Reef guard credential environment variable ${guard.apiKeyEnv} is unset`);
    }
  } else {
    const resolved = await resolveConfiguredSecretInputString({
      config: rootConfig,
      env: process.env,
      value: guard.apiKey,
      path: "channels.reef.guard.apiKey",
    });
    apiKey = resolved.value;
    if (!apiKey) {
      throw new Error(
        "Reef guard credential is unavailable; check channels.reef.guard.apiKey and its secret provider",
      );
    }
  }
  const options = {
    apiKey,
    pinnedModel: guard.pinnedModel,
    timeoutMs: guard.timeoutMs,
    baseUrl: guard.baseUrl,
    reasoningEffort: guard.reasoningEffort,
    rules: guard.rules,
    fetch: fetcher,
  };
  return guard.provider === "openai" ? createOpenAiGuard(options) : createAnthropicGuard(options);
}
