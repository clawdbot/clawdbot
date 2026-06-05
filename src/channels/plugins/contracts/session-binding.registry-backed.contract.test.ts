// Session binding registry contract tests cover channel session binding across registry fixtures.
import { getSessionBindingContractRegistry } from "./test-helpers/registry-session-binding.js";
import { describeSessionBindingRegistryBackedContract } from "./test-helpers/session-binding-registry-backed-contract.js";

for (const entry of getSessionBindingContractRegistry()) {
  describeSessionBindingRegistryBackedContract(entry.id);
}
