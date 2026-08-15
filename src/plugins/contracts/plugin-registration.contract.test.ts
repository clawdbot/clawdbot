// Plugin registration contract tests cover manifest registration cases exposed through the SDK.
import { pluginRegistrationContractCases } from "../../plugin-sdk/test-helpers/plugin-registration-contract-cases.js";
import { describePluginRegistrationContract } from "../../plugin-sdk/test-helpers/plugin-registration-contract.js";

const pluginRegistrationContractCaseList = Object.values(pluginRegistrationContractCases).toSorted(
  (left, right) => left.pluginId.localeCompare(right.pluginId),
);

for (const contractCase of pluginRegistrationContractCaseList) {
  describePluginRegistrationContract(contractCase);
}
