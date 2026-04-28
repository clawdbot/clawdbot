import { describeOpenAIProviderRuntimeContract } from "openclaw/plugin-sdk/provider-test-contracts";

describeOpenAIProviderRuntimeContract(() => import("./index.js"));
