import { describePluginRegistrationContract } from "openclaw/plugin-sdk/plugin-test-contracts";

describePluginRegistrationContract({
  pluginId: "comfy",
  providerIds: ["comfy"],
  imageGenerationProviderIds: ["comfy"],
  musicGenerationProviderIds: ["comfy"],
  videoGenerationProviderIds: ["comfy"],
  requireGenerateImage: true,
  requireGenerateVideo: true,
});
