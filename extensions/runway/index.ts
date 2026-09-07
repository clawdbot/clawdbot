// Runway plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-entry";
import { buildRunwayVideoGenerationProvider } from "./video-generation-provider.js";

export default definePluginEntry({
  id: "runway",
  name: "Runway Provider",
  description: "Bundled Runway video provider plugin",
  register(api) {
    api.registerProvider({
      id: "runway",
      label: "Runway",
      docsPath: "/providers/runway",
      envVars: ["RUNWAYML_API_SECRET", "RUNWAY_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: "runway",
          methodId: "api-key",
          label: "Runway API key",
          optionKey: "runwayApiKey",
          flagName: "--runway-api-key",
          envVar: "RUNWAYML_API_SECRET",
          promptMessage: "Enter Runway API key",
          wizard: {
            choiceId: "runway-api-key",
            choiceLabel: "Runway API key",
            groupId: "runway",
            groupLabel: "Runway",
            groupHint: "API key",
            onboardingScopes: ["image-generation"],
          },
        }),
      ],
    });
    api.registerVideoGenerationProvider(buildRunwayVideoGenerationProvider());
  },
});
