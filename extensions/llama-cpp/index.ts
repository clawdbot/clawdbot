import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { llamaCppEmbeddingProviderAdapter } from "./src/embedding-provider.js";
import { registerExternalLlamaServerProvider } from "./src/external-server/register.js";
import { registerManagedLlamaCppProvider } from "./src/managed-provider.js";

export default definePluginEntry({
  id: "llama-cpp",
  name: "llama.cpp Provider",
  description: "Managed and external llama.cpp servers for GGUF chat and embeddings",
  register(api: OpenClawPluginApi) {
    api.registerEmbeddingProvider(llamaCppEmbeddingProviderAdapter);
    registerManagedLlamaCppProvider(api);
    registerExternalLlamaServerProvider(api);
  },
});
