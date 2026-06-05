// Github Copilot tests cover provider runtime.contract plugin behavior.
import { describeGithubCopilotProviderRuntimeContract } from "openclaw/plugin-sdk/provider-test-contracts";

describeGithubCopilotProviderRuntimeContract(() => import("./index.js"));
