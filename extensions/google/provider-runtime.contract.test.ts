import { describeGoogleProviderRuntimeContract } from "../../test/helpers/plugins/provider-runtime-contract.js";

describeGoogleProviderRuntimeContract(() => import("./index.js"));
