import { pluginRegistrationContractCases } from "../../plugin-sdk/test-helpers/plugin-registration-contract-cases.js";
import {
  installPluginRegistrationContract,
  type PluginRegistrationContractResolver,
} from "../../plugin-sdk/test-helpers/plugin-registration-contract.js";
// Plugin registration contract tests cover manifest registration cases exposed through the SDK.
import { BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS } from "./inventory/bundled-capability-metadata.js";

const resolvePluginRegistrationContract: PluginRegistrationContractResolver = (pluginId) =>
  BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.find((entry) => entry.pluginId === pluginId);

const pluginRegistrationContractCaseList = Object.values(pluginRegistrationContractCases).toSorted(
  (left, right) => left.pluginId.localeCompare(right.pluginId),
);

for (const contractCase of pluginRegistrationContractCaseList) {
  installPluginRegistrationContract(contractCase, resolvePluginRegistrationContract);
}
