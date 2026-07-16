import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "ollama",
  providerIds: ["ollama"],
  webSearchProviderIds: ["ollama"],
});
