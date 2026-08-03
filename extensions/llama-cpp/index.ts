import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import {
  LLAMA_CPP_PROVIDER_ID,
  LLAMA_CPP_PROVIDER_LABEL,
  LLAMA_CPP_LOCAL_BASE_URL,
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
          hint: "Run one private GGUF model directly inside this Gateway",
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
      createStreamFn: ({ config, model, provider }) => {
        // Explicit HTTP routes sharing this provider id stay on the configured transport.
        if (model.baseUrl !== LLAMA_CPP_LOCAL_BASE_URL) {
          return undefined;
        }
        return createLlamaCppStreamFn({
          providerConfig: config?.models?.providers?.[provider],
        });
      },
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
          choiceHint: "Run one private GGUF model directly inside this Gateway",
          groupId: LLAMA_CPP_PROVIDER_ID,
          groupLabel: "Local llama.cpp",
          groupHint: "No API key required",
          methodId: "local",
        },
        modelPicker: {
          label: "llama.cpp",
          hint: "Run a GGUF model directly inside OpenClaw",
          methodId: "local",
        },
      },
    });
  },
});
