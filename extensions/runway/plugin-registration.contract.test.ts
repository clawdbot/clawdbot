import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "runway",
  videoGenerationProviderIds: ["runway"],
  requireGenerateVideo: true,
});
