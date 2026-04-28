import { describeZAIProviderRuntimeContract } from "openclaw/plugin-sdk/provider-test-contracts";

describeZAIProviderRuntimeContract(() => import("./index.js"));
