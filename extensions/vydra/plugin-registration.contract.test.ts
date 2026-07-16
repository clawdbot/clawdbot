import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "vydra",
  providerIds: ["vydra"],
  speechProviderIds: ["vydra"],
  imageGenerationProviderIds: ["vydra"],
  videoGenerationProviderIds: ["vydra"],
  requireSpeechVoices: true,
  requireGenerateImage: true,
  requireGenerateVideo: true,
  manifestAuthChoice: {
    pluginId: "vydra",
    choiceId: "vydra-api-key",
    choiceLabel: "Vydra API key",
    groupId: "vydra",
    groupLabel: "Vydra",
    groupHint: "Image, video, and speech",
  },
});
