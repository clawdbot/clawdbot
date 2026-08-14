import type { EmbeddingProviderStartupInspector } from "openclaw/plugin-sdk/embedding-providers";
import { DEFAULT_LLAMA_CPP_EMBEDDING_MODEL } from "./src/defaults.js";
import { inspectLlamaCppEmbeddingStartupPrerequisites } from "./src/embedding-provider-preflight.js";

export const embeddingProviderStartupInspectors: readonly EmbeddingProviderStartupInspector[] = [
  {
    id: "local",
    defaultModel: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
    transport: "local",
    inspectStartupPrerequisites: inspectLlamaCppEmbeddingStartupPrerequisites,
  },
];
