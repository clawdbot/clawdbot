import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import {
  LLAMA_CPP_PROVIDER_ID,
  LLAMA_CPP_PROVIDER_LABEL,
  buildLlamaCppProviderConfig,
  resolveLlamaCppSyntheticApiKey,
} from "./src/defaults.js";
import { llamaCppEmbeddingProviderAdapter } from "./src/embedding-provider.js";
import { ensureManagedLlamaServerForChat } from "./src/managed-server.js";
import { detectLlamaCppSetup, prepareLlamaCppSetup, runLlamaCppSetup } from "./src/setup.js";

export default definePluginEntry({
  id: "llama-cpp",
  name: "llama.cpp Provider",
  description: "Managed local llama.cpp server for GGUF chat and embeddings",
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
          hint: "Install a verified llama.cpp server and run a private GGUF model managed by OpenClaw",
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
      resolveSyntheticAuth: () => ({
        apiKey: resolveLlamaCppSyntheticApiKey(),
        source: "managed local llama.cpp server",
        mode: "api-key" as const,
      }),
      wrapStreamFn: (ctx) => {
        const inner = ctx.streamFn;
        const providerConfig = ctx.config?.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
        const selectedModel = ctx.model;
        if (!inner || !providerConfig?.localService || !selectedModel) {
          return undefined;
        }
        return async (model, context, options) => {
          await ensureManagedLlamaServerForChat({
            provider: providerConfig,
            model: selectedModel,
          });
          return inner(model, context, options);
        };
      },
      ...buildProviderToolCompatFamilyHooks("llamacpp-gbnf"),
      wizard: {
        setup: {
          choiceId: LLAMA_CPP_PROVIDER_ID,
          choiceLabel: LLAMA_CPP_PROVIDER_LABEL,
          choiceHint:
            "Install a verified llama.cpp server and run a private GGUF model managed by OpenClaw",
          groupId: LLAMA_CPP_PROVIDER_ID,
          groupLabel: "Local llama.cpp",
          groupHint: "No API key required",
          methodId: "local",
        },
        modelPicker: {
          label: "llama.cpp",
          hint: "Run a GGUF model with OpenClaw's managed local llama.cpp server",
          methodId: "local",
        },
      },
    });
  },
});
