// Gateway auth token resolution applies explicit/config/SecretRef/env
// precedence with caller-controlled env fallback behavior.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { trimToUndefined } from "./credentials.js";
import {
  resolveConfiguredSecretInputString,
  type SecretInputUnresolvedReasonStyle,
} from "./resolve-configured-secret-input-string.js";

// Single-token resolver for local gateway auth consumers that need to know
// whether the winning token came from explicit args, config, SecretRef, or env.
type GatewayAuthTokenResolutionSource = "explicit" | "config" | "secretRef" | "env";
type GatewayAuthTokenEnvFallback = "never" | "no-secret-ref" | "always";

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

  const tokenInput = params.cfg.gateway?.auth?.token;
  const tokenRef = resolveSecretInputRef({
    value: tokenInput,
    defaults: params.cfg.secrets?.defaults,
  }).ref;
  const envFallback = params.envFallback ?? "always";
  const envToken = trimToUndefined(params.env.OPENCLAW_GATEWAY_TOKEN);

  if (!tokenRef) {
    const configToken = trimToUndefined(tokenInput);
    if (configToken) {
      return {
        token: configToken,
        source: "config",
        secretRefConfigured: false,
      };
    }
    if (envFallback !== "never" && envToken) {
      return {
        token: envToken,
        source: "env",
        secretRefConfigured: false,
      };
    }
    return { secretRefConfigured: false };
  }

  const resolved = await resolveConfiguredSecretInputString({
    config: params.cfg,
    env: params.env,
    value: tokenInput,
    path: "gateway.auth.token",
    unresolvedReasonStyle: params.unresolvedReasonStyle,
  });
  if (resolved.value) {
    return {
      token: resolved.value,
      source: "secretRef",
      secretRefConfigured: true,
    };
  }
  // Env fallback after a configured SecretRef is intentionally opt-in so
  // callers can fail closed when unresolved secrets should block startup.
  if (envFallback === "always" && envToken) {
    return {
      token: envToken,
      source: "env",
      secretRefConfigured: true,
    };
  }
  return {
    secretRefConfigured: true,
    unresolvedRefReason: resolved.unresolvedRefReason,
  };
}
