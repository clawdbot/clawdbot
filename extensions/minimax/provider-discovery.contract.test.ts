import { describeMinimaxProviderDiscoveryContract } from "../../test/helpers/plugins/provider-discovery-contract.js";

describeMinimaxProviderDiscoveryContract(() => import("./index.js"));
