import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "comfy",
  providerIds: ["comfy"],
  imageGenerationProviderIds: ["comfy"],
  musicGenerationProviderIds: ["comfy"],
  videoGenerationProviderIds: ["comfy"],
  requireGenerateImage: true,
  requireGenerateVideo: true,
});
