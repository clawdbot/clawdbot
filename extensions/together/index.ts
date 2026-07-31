// Together plugin entrypoint registers its OpenClaw integration.
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyTogetherConfig } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { buildTogetherVideoGenerationProvider } from "./video-generation-provider.js";

const PROVIDER_ID = "together";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Together Provider",
  description: "Bundled Together provider plugin",
  manifest,
  provider: {
    label: "Together",
    docsPath: "/providers/together",
    manifestAuth: { applyConfig: applyTogetherConfig },
    catalog: { liveModelDiscovery: true },
    classifyFailoverReason: ({ errorMessage }) =>
      /\bconcurrency limit\b.*\b(?:breached|reached)\b/i.test(errorMessage)
        ? "rate_limit"
        : undefined,
  },
  register(api) {
    api.registerVideoGenerationProvider(buildTogetherVideoGenerationProvider());
  },
});
