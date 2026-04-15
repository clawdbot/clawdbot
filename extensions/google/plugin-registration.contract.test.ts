import { pluginRegistrationContractCases } from "../../test/helpers/plugins/plugin-registration-contract-cases.js";
import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  ...pluginRegistrationContractCases.google,
  videoGenerationProviderIds: ["google"],
  webSearchProviderIds: ["gemini"],
  requireDescribeImages: true,
  requireGenerateImage: true,
  requireGenerateVideo: true,
});
