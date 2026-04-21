import { describeOpenAIProviderRuntimeContract } from "../../test/helpers/plugins/provider-runtime-contract.js";

describeOpenAIProviderRuntimeContract(() => import("./index.js"));
