import {
  describeCloudflareAiGatewayProviderDiscoveryContract,
  describeGithubCopilotProviderDiscoveryContract,
  describeMinimaxProviderDiscoveryContract,
  describeModelStudioProviderDiscoveryContract,
  describeSglangProviderDiscoveryContract,
  describeVllmProviderDiscoveryContract,
} from "../../../test/helpers/plugins/provider-discovery-contract.js";

describeCloudflareAiGatewayProviderDiscoveryContract();
describeGithubCopilotProviderDiscoveryContract();
describeMinimaxProviderDiscoveryContract();
describeModelStudioProviderDiscoveryContract();
describeSglangProviderDiscoveryContract();
describeVllmProviderDiscoveryContract();
