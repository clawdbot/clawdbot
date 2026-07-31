import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { isModernCohereModelId } from "./models.js";
import { applyCohereConfig } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { COHERE_LIVE_MODEL_DISCOVERY } from "./provider-catalog.js";
import { createCohereCompletionsWrapper } from "./stream.js";

export default defineSingleProviderPluginEntry({
  id: "cohere",
  name: "Cohere Provider",
  description: "Cohere provider plugin",
  manifest,
  provider: {
    label: "Cohere",
    docsPath: "/providers/cohere",
    manifestAuth: { applyConfig: applyCohereConfig },
    catalog: {
      liveModelDiscovery: COHERE_LIVE_MODEL_DISCOVERY,
    },
    wrapStreamFn: (ctx) => createCohereCompletionsWrapper(ctx.streamFn),
    wrapSimpleCompletionStreamFn: (ctx) => createCohereCompletionsWrapper(ctx.streamFn),
    isModernModelRef: ({ modelId }) => isModernCohereModelId(modelId),
  },
});
