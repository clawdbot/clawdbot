// Microsoft Foundry plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildMicrosoftFoundryImageGenerationProvider } from "./image-generation-provider.js";
import { buildMicrosoftFoundryProvider } from "./provider.js";

export default definePluginEntry({
  id: "microsoft-foundry",
  name: "Microsoft Foundry Provider",
  description: "Microsoft Foundry provider with Entra ID and API key auth",
  register(api) {
    api.registerProvider(buildMicrosoftFoundryProvider());
    api.registerImageGenerationProvider(buildMicrosoftFoundryImageGenerationProvider());
  },
});
