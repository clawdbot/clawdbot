// Gateway auth token resolution applies explicit/config/SecretRef/env
// precedence with caller-controlled env fallback behavior.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { trimToUndefined } from "./credentials.js";
import {
  resolveConfiguredSecretInputWithFallback,
  type SecretInputUnresolvedReasonStyle,
} from "./resolve-configured-secret-input-string.js";

// Single-token resolver for local gateway auth consumers that need to know
// whether the winning token came from explicit args, config, SecretRef, or env.
type GatewayAuthTokenResolutionSource = "explicit" | "config" | "secretRef" | "env";
type GatewayAuthTokenEnvFallback = "never" | "no-secret-ref";

/** Resolves gateway.auth.token with configurable env fallback and SecretRef diagnostics. */
export async function resolveGatewayAuthToken(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  explicitToken?: string;
  envFallback?: GatewayAuthTokenEnvFallback;
  unresolvedReasonStyle?: SecretInputUnresolvedReasonStyle;
}): Promise<{
  token?: string;
  source?: GatewayAuthTokenResolutionSource;
  secretRefConfigured: boolean;
  unresolvedRefReason?: string;
}> {
  const explicitToken = trimToUndefined(params.explicitToken);
  if (explicitToken) {
    return {
      token: explicitToken,
      source: "explicit",
      secretRefConfigured: false,
    };
  }

  const resolved = await resolveConfiguredSecretInputWithFallback({
    config: params.cfg,
    env: params.env,
    value: params.cfg.gateway?.auth?.token,
    path: "gateway.auth.token",
    unresolvedReasonStyle: params.unresolvedReasonStyle,
    ...(params.envFallback !== "never"
      ? { readFallback: () => params.env.OPENCLAW_GATEWAY_TOKEN }
      : {}),
  });
  return {
    ...(resolved.value ? { token: resolved.value } : {}),
    ...(resolved.source
      ? { source: resolved.source === "fallback" ? ("env" as const) : resolved.source }
      : {}),
    secretRefConfigured: resolved.secretRefConfigured,
    ...(resolved.unresolvedRefReason ? { unresolvedRefReason: resolved.unresolvedRefReason } : {}),
  };
}
