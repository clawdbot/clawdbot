// WebSocket shared-session generation hashes gateway auth inputs so clients can detect credential rotation.
import type { GatewayTrustedProxyConfig } from "../../config/types.gateway.js";
import { sha256Base64Url } from "../../infra/crypto-digest.js";
import type { ResolvedGatewayAuth } from "../auth.js";

function resolveSharedSecret(
  auth: ResolvedGatewayAuth,
): { mode: "token" | "password"; secret: string } | null {
  // trim() is only a blank-value guard; generation must hash the exact raw secret bytes.
  if (auth.mode === "token" && typeof auth.token === "string" && auth.token.trim().length > 0) {
    return { mode: "token", secret: auth.token };
  }
  if (
    auth.mode === "password" &&
    typeof auth.password === "string" &&
    auth.password.trim().length > 0
  ) {
    return { mode: "password", secret: auth.password };
  }
  return null;
}

function normalizeTrustedProxyConfig(trustedProxy: GatewayTrustedProxyConfig | undefined): {
  userHeader: string | undefined;
  requiredHeaders: string[];
  allowUsers: string[];
  allowLoopback: boolean | undefined;
} {
  return {
    userHeader: trustedProxy?.userHeader,
    requiredHeaders: [...(trustedProxy?.requiredHeaders ?? [])].toSorted(),
    allowUsers: [...(trustedProxy?.allowUsers ?? [])].toSorted(),
    allowLoopback: trustedProxy?.allowLoopback,
  };
}

export function resolveSharedGatewaySessionGeneration(
  auth: ResolvedGatewayAuth,
  trustedProxies?: readonly string[],
): string | undefined {
  const shared = resolveSharedSecret(auth);
  if (shared) {
    return sha256Base64Url(`${shared.mode}\u0000${shared.secret}`);
  }
  if (auth.mode === "trusted-proxy") {
    return sha256Base64Url(
      JSON.stringify({
        mode: auth.mode,
        trustedProxy: normalizeTrustedProxyConfig(auth.trustedProxy),
        trustedProxies: [...(trustedProxies ?? [])].toSorted(),
      }),
    );
  }
  return undefined;
}
