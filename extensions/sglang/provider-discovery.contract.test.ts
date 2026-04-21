import { fileURLToPath } from "node:url";
import { describeSglangProviderDiscoveryContract } from "../../test/helpers/plugins/provider-discovery-contract.js";

describeSglangProviderDiscoveryContract({
  load: () => import("./index.js"),
  apiModuleId: fileURLToPath(new URL("./api.js", import.meta.url)),
});
