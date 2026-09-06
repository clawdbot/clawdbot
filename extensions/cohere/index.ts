import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { isModernCohereModelId } from "./models.js";
import { applyCohereConfig } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { COHERE_LIVE_MODEL_DISCOVERY } from "./provider-catalog.js";
import { wrapCohereProviderStream } from "./stream.js";

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
      discoveryMode: "strict",
      liveModelDiscovery: COHERE_LIVE_MODEL_DISCOVERY,
    },
    wrapStreamFn: wrapCohereProviderStream,
    wrapSimpleCompletionStreamFn: wrapCohereProviderStream,
    isModernModelRef: ({ modelId }) => isModernCohereModelId(modelId),
  },
});
