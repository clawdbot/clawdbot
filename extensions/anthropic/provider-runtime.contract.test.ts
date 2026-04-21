import { describeAnthropicProviderRuntimeContract } from "../../test/helpers/plugins/provider-runtime-contract.js";

describeAnthropicProviderRuntimeContract(() => import("./index.js"));
