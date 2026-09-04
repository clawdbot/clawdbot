import type { OpenClawConfig } from "../config/config.js";
import { isBuiltInDefaultSecretProviderRef } from "../secrets/ref-contract.js";

/** Checks env provider selection and allowlists without resolving a credential. */
export function canResolveEnvSecretRefInReadOnlyPath(params: {
  cfg?: OpenClawConfig;
  provider: string;
  id: string;
}): boolean {
  const providerConfig = params.cfg?.secrets?.providers?.[params.provider];
  if (providerConfig?.source === "env") {
    const allowlist = providerConfig.allowlist;
    return !allowlist || allowlist.includes(params.id);
  }
  return isBuiltInDefaultSecretProviderRef(params.cfg ?? {}, {
    source: "env",
    provider: params.provider,
    id: params.id,
  });
}
