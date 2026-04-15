import { pluginRegistrationContractCases } from "../../test/helpers/plugins/plugin-registration-contract-cases.js";
import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  ...pluginRegistrationContractCases.openai,
  videoGenerationProviderIds: ["openai"],
  requireGenerateImage: true,
  requireGenerateVideo: true,
});
