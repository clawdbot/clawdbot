import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "xai",
  providerIds: ["xai"],
  webSearchProviderIds: ["grok"],
  videoGenerationProviderIds: ["xai"],
  toolNames: ["code_execution", "x_search"],
  requireGenerateVideo: true,
});
