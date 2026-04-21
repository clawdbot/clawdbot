import { describeCloudflareAiGatewayProviderDiscoveryContract } from "../../test/helpers/plugins/provider-discovery-contract.js";

describeCloudflareAiGatewayProviderDiscoveryContract(() => import("./index.js"));
