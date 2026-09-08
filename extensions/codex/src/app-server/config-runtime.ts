import { resolveProviderIdForAuth } from "openclaw/plugin-sdk/provider-auth-aliases";
import { createCodexAppServerConfig } from "./config-options.js";

// Cold callers remain complete without a registered Gateway runtime.
export const {
  resolveCodexAppServerRuntimeOptions,
  resolveCodexSupervisionAppServerRuntimeOptions,
} = createCodexAppServerConfig({ resolveProviderIdForAuth });

export {
  codexAppServerStartOptionsKey,
  codexSandboxPolicyForTurn,
  resolveCodexAppServerHomeScope,
  resolveCodexAppServerStartOptionsForAgent,
  resolveCodexComputerUseConfig,
} from "./config-options.js";
