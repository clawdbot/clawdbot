import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyCerebrasConfig, CEREBRAS_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildCerebrasProvider } from "./provider-catalog.js";

const PROVIDER_ID = "cerebras";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Cerebras Provider",
  description: "Bundled Cerebras provider plugin",
  provider: {
    label: "Cerebras",
    docsPath: "/providers/cerebras",
    auth: [
      {
        methodId: "api-key",
        label: "Cerebras API key",
        hint: "Fast OpenAI-compatible inference",
        optionKey: "cerebrasApiKey",
        flagName: "--cerebras-api-key",
        envVar: "CEREBRAS_API_KEY",
        promptMessage: "Enter Cerebras API key",
        defaultModel: CEREBRAS_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyCerebrasConfig(cfg),
        noteMessage: [
          "Cerebras provides high-speed OpenAI-compatible inference for GPT OSS, GLM, Qwen, and Llama models.",
          "Get your API key at: https://cloud.cerebras.ai",
        ].join("\n"),
        noteTitle: "Cerebras",
        wizard: {
          groupLabel: "Cerebras",
          groupHint: "Fast OpenAI-compatible inference",
        },
      },
    ],
    catalog: {
      buildProvider: buildCerebrasProvider,
      buildStaticProvider: buildCerebrasProvider,
    },
  },
});
