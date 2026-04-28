import { describePluginRegistrationContract } from "openclaw/plugin-sdk/plugin-test-contracts";

describePluginRegistrationContract({
  pluginId: "byteplus",
  providerIds: ["byteplus", "byteplus-plan"],
  videoGenerationProviderIds: ["byteplus"],
  requireGenerateVideo: true,
});
