import type { OpenClawConfig } from "../config/config.js";
import { resolveDefaultSecretProviderAlias } from "../secrets/ref-contract.js";

/** Checks whether a read-only plugin path may resolve a secret through an env provider. */
export function canResolveEnvSecretRefInReadOnlyPath(params: {
  cfg?: OpenClawConfig;
  provider: string;
  id: string;
}): boolean {
  const providerConfig = params.cfg?.secrets?.providers?.[params.provider];
  if (!providerConfig) {
    return params.provider === resolveDefaultSecretProviderAlias(params.cfg ?? {}, "env");
  }
  if (providerConfig.source !== "env") {
    return false;
  }
  const allowlist = providerConfig.allowlist;
  return !allowlist || allowlist.includes(params.id);
}
