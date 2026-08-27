import type { RegisteredEmbeddingProvider } from "./embedding-provider-types.js";
import { openAICompatibleEmbeddingProviderAdapter } from "./openai-compatible-embedding-provider.js";

export const CORE_EMBEDDING_PROVIDERS: RegisteredEmbeddingProvider[] = [
  {
    adapter: openAICompatibleEmbeddingProviderAdapter,
    ownerPluginId: "core",
  },
];

export function getCoreEmbeddingProvider(id: string): RegisteredEmbeddingProvider | undefined {
  return CORE_EMBEDDING_PROVIDERS.find((entry) => entry.adapter.id === id);
}
