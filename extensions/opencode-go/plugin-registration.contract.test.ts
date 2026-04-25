import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "opencode-go",
  providerIds: ["opencode-go"],
  mediaUnderstandingProviderIds: ["opencode-go"],
  requireDescribeImages: true,
});
