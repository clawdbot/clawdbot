import { fileURLToPath } from "node:url";
import { describeVllmProviderDiscoveryContract } from "../../test/helpers/plugins/provider-discovery-contract.js";

describeVllmProviderDiscoveryContract({
  load: () => import("./index.js"),
  apiModuleId: fileURLToPath(new URL("./api.js", import.meta.url)),
});
