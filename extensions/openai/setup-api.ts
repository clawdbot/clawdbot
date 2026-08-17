// Openai API module exposes the plugin public contract.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { ProviderAuthContext, ProviderAuthResult } from "openclaw/plugin-sdk/plugin-entry";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { createOpenAIProvider } from "./provider-contract-api.js";

async function runOpenAIProviderAuthMethod(
  methodId: string,
  ctx: ProviderAuthContext,
): Promise<ProviderAuthResult> {
  const { buildOpenAIProvider } = await import("./openai-provider.js");
  const method = buildOpenAIProvider().auth.find((entry) => entry.id === methodId);
  if (!method) {
    return { profiles: [] };
  }
  return method.run(ctx);
}

export function buildOpenAISetupProvider(): ProviderPlugin {
  const provider = createOpenAIProvider();
  for (const method of provider.auth) {
    method.run = async (ctx) => runOpenAIProviderAuthMethod(method.id, ctx);
  }
  return provider;
}

export default definePluginEntry({
  id: "openai",
  name: "OpenAI Setup",
  description: "Lightweight OpenAI setup hooks",
  register(api) {
    api.registerProvider(buildOpenAISetupProvider());
  },
});
