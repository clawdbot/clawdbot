import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildNvidiaProvider } from "./provider-catalog.js";

const PROVIDER_ID = "nvidia";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "NVIDIA Provider",
  description: "Bundled NVIDIA provider plugin",
  provider: {
    label: "NVIDIA",
    docsPath: "/providers/nvidia",
    envVars: ["NVIDIA_API_KEY"],
    auth: [],
    catalog: {
      buildProvider: buildNvidiaProvider,
    },
  },
});
