import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "alibaba",
  videoGenerationProviderIds: ["alibaba"],
  requireGenerateVideo: true,
});
