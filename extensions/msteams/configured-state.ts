import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { hasConfiguredSecretInput, normalizeSecretInputString } from "./src/secret-input.js";

/** Mirror Teams auth-mode requirements without loading the Azure SDK or full channel. */
export function hasConfiguredMSTeamsChannelState(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const config = params.cfg.channels?.msteams;
  if (config?.enabled === false) {
    return false;
  }
  const env = params.env ?? process.env;
  const appId = normalizeSecretInputString(
    config && Object.hasOwn(config, "appId") ? config.appId : env.MSTEAMS_APP_ID,
  );
  const tenantId = normalizeSecretInputString(
    config && Object.hasOwn(config, "tenantId") ? config.tenantId : env.MSTEAMS_TENANT_ID,
  );
  if (!appId || !tenantId) {
    return false;
  }
  const authType = config?.authType ?? env.MSTEAMS_AUTH_TYPE ?? "secret";
  if (authType === "federated") {
    const certificatePath = normalizeSecretInputString(
      config && Object.hasOwn(config, "certificatePath")
        ? config.certificatePath
        : env.MSTEAMS_CERTIFICATE_PATH,
    );
    return Boolean(
      certificatePath ||
      (config?.useManagedIdentity ?? env.MSTEAMS_USE_MANAGED_IDENTITY === "true"),
    );
  }
  return config && Object.hasOwn(config, "appPassword")
    ? hasConfiguredSecretInput(config.appPassword)
    : Boolean(normalizeSecretInputString(env.MSTEAMS_APP_PASSWORD));
}
