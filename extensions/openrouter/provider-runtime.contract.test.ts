import { describeOpenRouterProviderRuntimeContract } from "../../test/helpers/plugins/provider-runtime-contract.js";

describeOpenRouterProviderRuntimeContract(() => import("./index.js"));
