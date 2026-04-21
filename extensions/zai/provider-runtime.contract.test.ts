import { describeZAIProviderRuntimeContract } from "../../test/helpers/plugins/provider-runtime-contract.js";

describeZAIProviderRuntimeContract(() => import("./index.js"));
