import { describeWebFetchProviderContracts } from "../../plugin-sdk/test-helpers/web-fetch-provider-contract.js";
import { pluginRegistrationContractRegistry } from "./registry.js";

const webFetchProviderContractTests = pluginRegistrationContractRegistry.filter(
  (entry) => entry.webFetchProviderIds.length > 0,
);

for (const entry of webFetchProviderContractTests) {
  describeWebFetchProviderContracts(entry.pluginId);
}
