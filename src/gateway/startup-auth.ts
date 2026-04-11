import crypto from "node:crypto";
import type {
  GatewayAuthConfig,
  GatewayTailscaleConfig,
  OpenClawConfig,
} from "../config/config.js";
import { replaceConfigFile } from "../config/config.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  hasConfiguredGatewayAuthSecretInput,
  resolveGatewayPasswordSecretRefValue,
  resolveGatewayTokenSecretRefValue,
} from "./auth-config-utils.js";
import { assertExplicitGatewayAuthModeWhenBothConfigured } from "./auth-mode-policy.js";
import { resolveGatewayAuth, type ResolvedGatewayAuth } from "./auth.js";
import {
  hasGatewayPasswordEnvCandidate,
  hasGatewayTokenEnvCandidate,
  trimToUndefined,
} from "./credentials.js";

export function mergeGatewayAuthConfig(
  base?: GatewayAuthConfig,
  override?: GatewayAuthConfig,
): GatewayAuthConfig {
  const merged: GatewayAuthConfig = { ...base };
  if (!override) {
    return merged;
  }
  if (override.mode !== undefined) {
    merged.mode = override.mode;
  }
  if (override.token !== undefined) {
    merged.token = override.token;
  }
  if (override.password !== undefined) {
    merged.password = override.password;
  }
  if (override.allowTailscale !== undefined) {
    merged.allowTailscale = override.allowTailscale;
  }
  if (override.rateLimit !== undefined) {
    merged.rateLimit = override.rateLimit;
  }
  if (override.trustedProxy !== undefined) {
    merged.trustedProxy = override.trustedProxy;
  }
  return merged;
}

export function mergeGatewayTailscaleConfig(
  base?: GatewayTailscaleConfig,
  override?: GatewayTailscaleConfig,
): GatewayTailscaleConfig {
  const merged: GatewayTailscaleConfig = { ...base };
  if (!override) {
    return merged;
  }
  if (override.mode !== undefined) {
    merged.mode = override.mode;
  }
  if (override.resetOnExit !== undefined) {
    merged.resetOnExit = override.resetOnExit;
  }
  return merged;
}

function resolveGatewayAuthFromConfig(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  authOverride?: GatewayAuthConfig;
  tailscaleOverride?: GatewayTailscaleConfig;
}) {
  const tailscaleConfig = mergeGatewayTailscaleConfig(
    params.cfg.gateway?.tailscale,
    params.tailscaleOverride,
  );
  return resolveGatewayAuth({
    authConfig: params.cfg.gateway?.auth,
    authOverride: params.authOverride,
    env: params.env,
    tailscaleMode: tailscaleConfig.mode ?? "off",
  });
}

function shouldPersistGeneratedToken(params: {
  persistRequested: boolean;
  resolvedAuth: ResolvedGatewayAuth;
}): boolean {
  if (!params.persistRequested) {
    return false;
  }

  // Keep CLI/runtime mode overrides ephemeral: startup should not silently
  // mutate durable auth policy when mode was chosen by an override flag.
  if (params.resolvedAuth.modeSource === "override") {
    return false;
  }

  return true;
}

function hasGatewayTokenCandidate(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  authOverride?: GatewayAuthConfig;
}): boolean {
  const envToken = trimToUndefined(params.env.OPENCLAW_GATEWAY_TOKEN);
  if (envToken) {
    return true;
  }
  if (
    typeof params.authOverride?.token === "string" &&
    params.authOverride.token.trim().length > 0
  ) {
    return true;
  }
  return hasConfiguredGatewayAuthSecretInput(params.cfg, "gateway.auth.token");
}

function hasGatewayTokenOverrideCandidate(params: { authOverride?: GatewayAuthConfig }): boolean {
  return (
    typeof params.authOverride?.token === "string" && params.authOverride.token.trim().length > 0
  );
}

function hasGatewayPasswordOverrideCandidate(params: {
  env: NodeJS.ProcessEnv;
  authOverride?: GatewayAuthConfig;
}): boolean {
  if (hasGatewayPasswordEnvCandidate(params.env)) {
    return true;
  }
  return (
    typeof params.authOverride?.password === "string" &&
    params.authOverride.password.trim().length > 0
  );
}

export async function ensureGatewayStartupAuth(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  authOverride?: GatewayAuthConfig;
  tailscaleOverride?: GatewayTailscaleConfig;
  persist?: boolean;
  baseHash?: string;
}): Promise<{
  cfg: OpenClawConfig;
  auth: ReturnType<typeof resolveGatewayAuth>;
  generatedToken?: string;
  persistedGeneratedToken: boolean;
}> {
  assertExplicitGatewayAuthModeWhenBothConfigured(params.cfg);
  const env = params.env ?? process.env;
  const persistRequested = params.persist === true;
  const explicitMode = params.authOverride?.mode ?? params.cfg.gateway?.auth?.mode;
  const [resolvedTokenRefValue, resolvedPasswordRefValue] = await Promise.all([
    resolveGatewayTokenSecretRefValue({
      cfg: params.cfg,
      env,
      mode: explicitMode,
      hasTokenCandidate:
        hasGatewayTokenOverrideCandidate({ authOverride: params.authOverride }) ||
        hasGatewayTokenEnvCandidate(env),
      hasPasswordCandidate:
        hasGatewayPasswordOverrideCandidate({ env, authOverride: params.authOverride }) ||
        hasConfiguredGatewayAuthSecretInput(params.cfg, "gateway.auth.password"),
    }),
    resolveGatewayPasswordSecretRefValue({
      cfg: params.cfg,
      env,
      mode: explicitMode,
      hasPasswordCandidate: hasGatewayPasswordOverrideCandidate({
        env,
        authOverride: params.authOverride,
      }),
      hasTokenCandidate: hasGatewayTokenCandidate({
        cfg: params.cfg,
        env,
        authOverride: params.authOverride,
      }),
    }),
  ]);
  const authOverride: GatewayAuthConfig | undefined =
    params.authOverride || resolvedTokenRefValue || resolvedPasswordRefValue
      ? {
          ...params.authOverride,
          ...(resolvedTokenRefValue ? { token: resolvedTokenRefValue } : {}),
          ...(resolvedPasswordRefValue ? { password: resolvedPasswordRefValue } : {}),
        }
      : undefined;
  const resolved = resolveGatewayAuthFromConfig({
    cfg: params.cfg,
    env,
    authOverride,
    tailscaleOverride: params.tailscaleOverride,
  });
  if (resolved.mode !== "token" || (resolved.token?.trim().length ?? 0) > 0) {
    assertHooksTokenSeparateFromGatewayAuth({ cfg: params.cfg, auth: resolved });
    return { cfg: params.cfg, auth: resolved, persistedGeneratedToken: false };
  }

  const generatedToken = crypto.randomBytes(24).toString("hex");
  const nextCfg: OpenClawConfig = {
    ...params.cfg,
    gateway: {
      ...params.cfg.gateway,
      auth: {
        ...params.cfg.gateway?.auth,
        mode: "token",
        token: generatedToken,
      },
    },
  };
  const persist = shouldPersistGeneratedToken({
    persistRequested,
    resolvedAuth: resolved,
  });
  if (persist) {
    await replaceConfigFile({
      nextConfig: nextCfg,
      baseHash: params.baseHash,
    });
  }

  const nextAuth = resolveGatewayAuthFromConfig({
    cfg: nextCfg,
    env,
    authOverride: params.authOverride,
    tailscaleOverride: params.tailscaleOverride,
  });
  assertHooksTokenSeparateFromGatewayAuth({ cfg: nextCfg, auth: nextAuth });
  return {
    cfg: nextCfg,
    auth: nextAuth,
    generatedToken,
    persistedGeneratedToken: persist,
  };
}

export function assertHooksTokenSeparateFromGatewayAuth(params: {
  cfg: OpenClawConfig;
  auth: ResolvedGatewayAuth;
}): void {
  if (params.cfg.hooks?.enabled !== true) {
    return;
  }
  const hooksToken = normalizeOptionalString(params.cfg.hooks.token) ?? "";
  if (!hooksToken) {
    return;
  }
  const gatewayToken =
    params.auth.mode === "token" ? (normalizeOptionalString(params.auth.token) ?? "") : "";
  if (!gatewayToken) {
    return;
  }
  if (hooksToken !== gatewayToken) {
    return;
  }
  throw new Error(
    "Invalid config: hooks.token must not match gateway auth token. Set a distinct hooks.token for hook ingress.",
  );
}
