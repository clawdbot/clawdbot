import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { isModernCohereModelId } from "./models.js";
import { applyCohereConfig, COHERE_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildCohereProvider } from "./provider-catalog.js";
import { createCohereCompletionsWrapper } from "./stream.js";

export default defineSingleProviderPluginEntry({
  id: "cohere",
  name: "Cohere Provider",
  description: "Cohere provider plugin",
  provider: {
    label: "Cohere",
    docsPath: "/providers/cohere",
    auth: [
      {
        methodId: "api-key",
        label: "Cohere API key",
        hint: "OpenAI-compatible inference",
        optionKey: "cohereApiKey",
        flagName: "--cohere-api-key",
        envVar: "COHERE_API_KEY",
        promptMessage: "Enter Cohere API key",
        defaultModel: COHERE_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyCohereConfig(cfg),
        wizard: {
          groupLabel: "Cohere",
          groupHint: "OpenAI-compatible inference",
        },
      },
    ],
    catalog: {
      buildProvider: buildCohereProvider,
      buildStaticProvider: buildCohereProvider,
    },
    wrapStreamFn: (ctx) => createCohereCompletionsWrapper(ctx.streamFn),
    wrapSimpleCompletionStreamFn: (ctx) => createCohereCompletionsWrapper(ctx.streamFn),
    isModernModelRef: ({ modelId }) => isModernCohereModelId(modelId),
  },
});
