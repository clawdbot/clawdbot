import { describeVeniceProviderRuntimeContract } from "../../test/helpers/plugins/provider-runtime-contract.js";

describeVeniceProviderRuntimeContract(() => import("./index.js"));
