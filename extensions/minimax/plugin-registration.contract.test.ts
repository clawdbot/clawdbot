import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "minimax",
  providerIds: ["minimax", "minimax-portal"],
  speechProviderIds: ["minimax"],
  mediaUnderstandingProviderIds: ["minimax", "minimax-portal"],
  imageGenerationProviderIds: ["minimax", "minimax-portal"],
  musicGenerationProviderIds: ["minimax", "minimax-portal"],
  videoGenerationProviderIds: ["minimax", "minimax-portal"],
  webSearchProviderIds: ["minimax"],
  requireDescribeImages: true,
  requireGenerateImage: true,
  requireGenerateVideo: true,
});
