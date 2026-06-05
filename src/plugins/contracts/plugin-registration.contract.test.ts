// Plugin registration contract tests cover manifest registration cases exposed through the SDK.
import { pluginRegistrationContractCases } from "openclaw/plugin-sdk/plugin-test-contracts";
import { describePluginRegistrationContract } from "openclaw/plugin-sdk/plugin-test-contracts";

const pluginRegistrationContractCaseList = Object.values(pluginRegistrationContractCases).toSorted(
  (left, right) => left.pluginId.localeCompare(right.pluginId),
);

for (const contractCase of pluginRegistrationContractCaseList) {
  describePluginRegistrationContract(contractCase);
}
