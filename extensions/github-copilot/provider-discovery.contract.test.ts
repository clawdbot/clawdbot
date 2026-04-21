import { fileURLToPath } from "node:url";
import { describeGithubCopilotProviderDiscoveryContract } from "../../test/helpers/plugins/provider-discovery-contract.js";

describeGithubCopilotProviderDiscoveryContract({
  load: () => import("./index.js"),
  registerRuntimeModuleId: fileURLToPath(new URL("./register.runtime.js", import.meta.url)),
});
