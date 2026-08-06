/** Resolves gateway service auth tokens without leaking exec-backed secrets during install. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { resolveGatewayAuthToken } from "../gateway/auth-token-resolution.js";
import { trimToUndefined } from "../gateway/credentials.js";

/**
 * Resolves the token a managed gateway service can receive at install/update time.
 *
 * Exec SecretRefs are skipped by default because the service installer cannot safely evaluate
 * arbitrary commands; OPENCLAW_GATEWAY_TOKEN remains an explicit env override.
 */
export async function resolveGatewayAuthTokenForService(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  options: { allowExecSecretRefs?: boolean } = {},
): Promise<{ token?: string; unavailableReason?: string }> {
  const tokenRef = resolveSecretInputRef({
    value: cfg.gateway?.auth?.token,
    defaults: cfg.secrets?.defaults,
  }).ref;
  if (tokenRef?.source === "exec" && options.allowExecSecretRefs !== true) {
    const envToken = trimToUndefined(env.OPENCLAW_GATEWAY_TOKEN);
    return envToken ? { token: envToken } : {};
  }
  const resolved = await resolveGatewayAuthToken({
    cfg,
    env,
    unresolvedReasonStyle: "detailed",
    envFallback: "always",
  });
  if (resolved.token) {
    return { token: resolved.token };
  }
  if (!resolved.secretRefConfigured) {
    return {};
  }
  if (resolved.unresolvedRefReason?.includes("resolved to an empty value")) {
    return { unavailableReason: resolved.unresolvedRefReason };
  }
  return {
    unavailableReason: `gateway.auth.token SecretRef is configured but unresolved (${resolved.unresolvedRefReason ?? "unknown reason"}).`,
  };
}
