import { describePluginRegistrationContract } from "openclaw/plugin-sdk/plugin-test-contracts";

describePluginRegistrationContract({
  pluginId: "opencode-go",
  providerIds: ["opencode-go"],
  mediaUnderstandingProviderIds: ["opencode-go"],
  requireDescribeImages: true,
});
