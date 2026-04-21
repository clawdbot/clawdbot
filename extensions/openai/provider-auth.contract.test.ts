import { describeOpenAICodexProviderAuthContract } from "../../test/helpers/plugins/provider-auth-contract.js";

describeOpenAICodexProviderAuthContract(() => import("./index.js"));
