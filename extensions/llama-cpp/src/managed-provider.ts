import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import {
  LLAMA_CPP_PROVIDER_ID,
  LLAMA_CPP_PROVIDER_LABEL,
  buildLlamaCppProviderConfig,
  resolveLlamaCppSyntheticApiKey,
} from "./defaults.js";
import { ensureManagedLlamaServerForChat } from "./managed-server.js";
import { detectLlamaCppSetup, prepareLlamaCppSetup, runLlamaCppSetup } from "./setup.js";

export function registerManagedLlamaCppProvider(api: OpenClawPluginApi): void {
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
        choiceLabel: "Managed local server",
        choiceHint:
          "Install a verified llama.cpp server and run a private GGUF model managed by OpenClaw",
        groupId: LLAMA_CPP_PROVIDER_ID,
        groupLabel: "Local llama.cpp",
        groupHint: "Managed or external llama.cpp server",
        methodId: "local",
      },
      modelPicker: {
        label: "llama.cpp (managed)",
        hint: "Run a GGUF model with OpenClaw's managed local llama.cpp server",
        methodId: "local",
      },
    },
  });
}
