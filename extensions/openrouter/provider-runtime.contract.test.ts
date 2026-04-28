import { describeOpenRouterProviderRuntimeContract } from "openclaw/plugin-sdk/provider-test-contracts";

describeOpenRouterProviderRuntimeContract(() => import("./index.js"));
