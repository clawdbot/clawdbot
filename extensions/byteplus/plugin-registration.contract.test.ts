import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "byteplus",
  providerIds: ["byteplus", "byteplus-plan"],
  videoGenerationProviderIds: ["byteplus"],
  requireGenerateVideo: true,
});
