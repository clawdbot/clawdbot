import { describeGithubCopilotProviderRuntimeContract } from "openclaw/plugin-sdk/provider-test-contracts";

describeGithubCopilotProviderRuntimeContract(() => import("./index.js"));
