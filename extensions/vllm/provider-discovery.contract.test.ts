import { fileURLToPath } from "node:url";
import { describeVllmProviderDiscoveryContract } from "openclaw/plugin-sdk/provider-test-contracts";

describeVllmProviderDiscoveryContract({
  load: () => import("./index.js"),
  apiModuleId: fileURLToPath(new URL("./api.js", import.meta.url)),
});
