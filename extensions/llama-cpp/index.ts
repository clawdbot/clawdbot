import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import {
  LLAMA_CPP_PROVIDER_ID,
  LLAMA_CPP_PROVIDER_LABEL,
  buildLlamaCppProviderConfig,
  resolveLlamaCppSyntheticApiKey,
} from "./src/defaults.js";
import { llamaCppEmbeddingProviderAdapter } from "./src/embedding-provider.js";
import { createLlamaCppStreamFn } from "./src/inference-provider.js";
import { detectLlamaCppSetup, prepareLlamaCppSetup, runLlamaCppSetup } from "./src/setup.js";

export default definePluginEntry({
  id: "llama-cpp",
  name: "llama.cpp Provider",
  description: "Local GGUF text inference and embeddings through node-llama-cpp",
  register(api: OpenClawPluginApi) {
    api.registerEmbeddingProvider(llamaCppEmbeddingProviderAdapter);
    api.registerProvider({
      id: LLAMA_CPP_PROVIDER_ID,
      label: LLAMA_CPP_PROVIDER_LABEL,
      docsPath: "/plugins/llama-cpp",
      auth: [
        {
          id: "local",
          label: LLAMA_CPP_PROVIDER_LABEL,
          hint: "In-process local GGUF model (about 5.0 GB download; requires 16 GB RAM)",
          kind: "custom",
          appGuidedSetup: {
            detect: detectLlamaCppSetup,
            prepare: prepareLlamaCppSetup,
          },
          run: runLlamaCppSetup,
        },
      ],
      catalog: {
        order: "late",
        run: async (ctx) => ({
          provider: buildLlamaCppProviderConfig(
            ctx.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID],
          ),
        }),
      },
      staticCatalog: {
        order: "late",
        run: async () => ({ provider: buildLlamaCppProviderConfig() }),
      },
      createStreamFn: ({ config, provider }) =>
        createLlamaCppStreamFn({
          providerConfig: config?.models?.providers?.[provider],
        }),
      resolveSyntheticAuth: () => ({
        apiKey: resolveLlamaCppSyntheticApiKey(),
        source: "local llama.cpp runtime",
        mode: "api-key" as const,
      }),
      ...buildProviderToolCompatFamilyHooks("llamacpp-gbnf"),
      wizard: {
        setup: {
          choiceId: LLAMA_CPP_PROVIDER_ID,
          choiceLabel: LLAMA_CPP_PROVIDER_LABEL,
          choiceHint: "In-process local model (about 5.0 GB download; requires 16 GB RAM)",
          groupId: LLAMA_CPP_PROVIDER_ID,
          groupLabel: "Local llama.cpp",
          groupHint: "No API key required",
          methodId: "local",
        },
        modelPicker: {
          label: "llama.cpp (local GGUF)",
          hint: "Run a GGUF model in the OpenClaw process",
          methodId: "local",
        },
      },
    });
  },
});
