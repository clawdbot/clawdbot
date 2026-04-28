import { describeAnthropicProviderRuntimeContract } from "openclaw/plugin-sdk/provider-test-contracts";

describeAnthropicProviderRuntimeContract(() => import("./index.js"));
