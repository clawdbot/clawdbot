import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
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
      auth: [],
    });
    api.registerImageGenerationProvider(buildComfyImageGenerationProvider());
    api.registerMusicGenerationProvider(buildComfyMusicGenerationProvider());
    api.registerVideoGenerationProvider(buildComfyVideoGenerationProvider());
  },
});
