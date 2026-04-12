import type { OpenClawConfig } from "../config/types.openclaw.js";
export { shouldRequireGatewayTokenForInstall } from "../gateway/auth-install-policy.js";
import { resolveGatewayAuthToken } from "../gateway/auth-token-resolution.js";

export async function resolveGatewayAuthTokenForService(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Promise<{ token?: string; unavailableReason?: string }> {
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
