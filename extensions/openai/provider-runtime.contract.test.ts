// Openai tests cover provider runtime.contract plugin behavior.
import { describeOpenAIProviderRuntimeContract } from "openclaw/plugin-sdk/provider-test-contracts";

describeOpenAIProviderRuntimeContract(() => import("./index.js"));
