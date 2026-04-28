import { describeGithubCopilotProviderAuthContract } from "openclaw/plugin-sdk/provider-test-contracts";

describeGithubCopilotProviderAuthContract(() => import("./index.js"));
