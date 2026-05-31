import { describePluginRegistrationContract } from "openclaw/plugin-sdk/plugin-test-contracts";

describePluginRegistrationContract({
  pluginId: "qwen",
  providerIds: [
    "qwen",
    "qwencloud",
    "modelstudio",
    "dashscope",
    "qwen-oauth",
    "qwen-portal",
    "qwen-cli",
  ],
  mediaUnderstandingProviderIds: ["qwen"],
  videoGenerationProviderIds: ["qwen"],
  requireDescribeImages: true,
  requireGenerateVideo: true,
});
