import { describePluginRegistrationContract } from "openclaw/plugin-sdk/plugin-test-contracts";

describePluginRegistrationContract({
  pluginId: "pixverse",
  videoGenerationProviderIds: ["pixverse"],
  requireGenerateVideo: true,
});
