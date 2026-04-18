import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildFalImageGenerationProvider } from "./image-generation-provider.js";
import { createFalProvider } from "./provider-registration.js";
import { buildFalVideoGenerationProvider } from "./video-generation-provider.js";

const PROVIDER_ID = "fal";

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "fal Provider",
  description: "Bundled fal image and video generation provider",
  register(api) {
    api.registerProvider(createFalProvider());
    api.registerImageGenerationProvider(buildFalImageGenerationProvider());
    api.registerVideoGenerationProvider(buildFalVideoGenerationProvider());
  },
});
