import { describeGithubCopilotProviderRuntimeContract } from "../../test/helpers/plugins/provider-runtime-contract.js";

describeGithubCopilotProviderRuntimeContract(() => import("./index.js"));
