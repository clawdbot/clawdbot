// Github Copilot tests cover provider auth.contract plugin behavior.
import { describeGithubCopilotProviderAuthContract } from "openclaw/plugin-sdk/provider-test-contracts";

describeGithubCopilotProviderAuthContract(() => import("./index.js"));
