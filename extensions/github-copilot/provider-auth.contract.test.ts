import { describeGithubCopilotProviderAuthContract } from "../../test/helpers/plugins/provider-auth-contract.js";

describeGithubCopilotProviderAuthContract(() => import("./index.js"));
