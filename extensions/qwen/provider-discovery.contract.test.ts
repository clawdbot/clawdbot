import { describeModelStudioProviderDiscoveryContract } from "../../test/helpers/plugins/provider-discovery-contract.js";

describeModelStudioProviderDiscoveryContract(() => import("./index.js"));
