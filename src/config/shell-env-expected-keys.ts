import { listKnownChannelEnvVarNames } from "../secrets/channel-env-vars.js";
import { listKnownProviderAuthEnvVarNames } from "../secrets/provider-env-vars.js";
import { uniqueStrings } from "../shared/string-normalization.js";

const CORE_SHELL_ENV_EXPECTED_KEYS = ["OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_PASSWORD"];

export function resolveShellEnvExpectedKeys(env: NodeJS.ProcessEnv): string[] {
  return uniqueStrings([
    ...listKnownProviderAuthEnvVarNames({ env }),
    ...listKnownChannelEnvVarNames({ env }),
    ...CORE_SHELL_ENV_EXPECTED_KEYS,
  ]);
}
