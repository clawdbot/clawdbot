import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { buildComfyImageGenerationProvider } from "./image-generation-provider.js";
import { buildComfyMusicGenerationProvider } from "./music-generation-provider.js";
import { buildComfyVideoGenerationProvider } from "./video-generation-provider.js";

const PROVIDER_ID = "comfy";

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "ComfyUI Provider",
  description: "Bundled ComfyUI workflow media generation provider",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "ComfyUI",
      docsPath: "/providers/comfy",
      envVars: ["COMFY_API_KEY", "COMFY_CLOUD_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "cloud-api-key",
          label: "Comfy Cloud API key",
          hint: "API key for Comfy Cloud workflow runs",
          optionKey: "comfyApiKey",
          flagName: "--comfy-api-key",
          envVar: "COMFY_API_KEY",
          promptMessage: "Enter Comfy Cloud API key",
          wizard: {
            choiceId: "comfy-cloud-api-key",
            choiceLabel: "Comfy Cloud API key",
            choiceHint: "Required for cloud workflows",
            groupId: "comfy",
            groupLabel: "ComfyUI",
            groupHint: "Local or cloud workflows",
            onboardingScopes: ["image-generation"],
          },
        }),
      ],
    });
    api.registerImageGenerationProvider(buildComfyImageGenerationProvider());
    api.registerMusicGenerationProvider(buildComfyMusicGenerationProvider());
    api.registerVideoGenerationProvider(buildComfyVideoGenerationProvider());
  },
});
