import { loadBundledPluginApiSync } from "../../test-utils/bundled-plugin-public-surface.js";
import type { ProviderPlugin } from "../types.js";

export type ProviderContractEntry = {
  pluginId: string;
  provider: ProviderPlugin;
};

let providerContractRegistryCache: ProviderContractEntry[] | null = null;

type ProviderApiSurface<TFactoryName extends string> = Record<TFactoryName, () => ProviderPlugin>;
type AnthropicApiSurface = ProviderApiSurface<"buildAnthropicProvider">;
type GoogleApiSurface = ProviderApiSurface<"buildGoogleProvider" | "buildGoogleGeminiCliProvider">;
type OpenAIApiSurface = ProviderApiSurface<
  "buildOpenAIProvider" | "buildOpenAICodexProviderPlugin"
>;

export function loadVitestProviderContractRegistry(): ProviderContractEntry[] {
  const anthropicApi = loadBundledPluginApiSync<AnthropicApiSurface>("anthropic");
  const googleApi = loadBundledPluginApiSync<GoogleApiSurface>("google");
  const openAIApi = loadBundledPluginApiSync<OpenAIApiSurface>("openai");
  providerContractRegistryCache ??= [
    { pluginId: "anthropic", provider: anthropicApi.buildAnthropicProvider() },
    { pluginId: "google", provider: googleApi.buildGoogleProvider() },
    { pluginId: "google", provider: googleApi.buildGoogleGeminiCliProvider() },
    { pluginId: "openai", provider: openAIApi.buildOpenAIProvider() },
    { pluginId: "openai", provider: openAIApi.buildOpenAICodexProviderPlugin() },
  ];
  return providerContractRegistryCache;
}
