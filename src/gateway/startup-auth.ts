// Gateway startup auth preparation.
// Merges auth overrides, resolves secret refs, validates weak secrets, and generates fallbacks.
import crypto from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  GatewayAuthConfig,
  GatewayBindMode,
  GatewayTailscaleConfig,
} from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  GATEWAY_AUTH_SURFACE_PATHS,
  evaluateGatewayAuthSurfaceStates,
} from "../secrets/runtime-gateway-auth-surfaces.js";
import {
  hasConfiguredGatewayAuthSecretInput,
  resolveGatewayPasswordSecretRefValue,
  resolveGatewayTokenSecretRefValue,
} from "./auth-config-utils.js";
import { assertExplicitGatewayAuthModeWhenBothConfigured } from "./auth-mode-policy.js";
import { resolveGatewayAuth, type ResolvedGatewayAuth } from "./auth.js";
import { trimToUndefined } from "./credentials.js";
import { assertGatewayAuthNotKnownWeak } from "./known-weak-gateway-secrets.js";
import { isContainerEnvironment, isLoopbackHost, isValidIPv4 } from "./net.js";

const HOOKS_GATEWAY_AUTH_REUSE_WARNING =
  "Security warning: hooks.token matches active Gateway shared-secret auth. Startup continues for compatibility; rotate hooks.token or Gateway auth. Run openclaw security audit for a full report, and run openclaw doctor --fix when the reused hooks.token is persisted in config.";

/** Merge sparse runtime auth overrides into persisted Gateway auth config. */
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

/** Merge sparse runtime Tailscale overrides into persisted Gateway Tailscale config. */
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
  if (override.serviceName !== undefined) {
    merged.serviceName = override.serviceName;
  }
  if (override.preserveFunnel !== undefined) {
    merged.preserveFunnel = override.preserveFunnel;
  }
  return merged;
}

export type GatewayStartupAuthInspection = {
  auth: ResolvedGatewayAuth;
  hasSharedSecret: boolean;
  passwordMissing: boolean;
  activeSecretRefPaths: string[];
  explicitModeRequiredError?: string;
  knownWeakCredentialError?: string;
};

const GATEWAY_AUTH_SHELL_ENV_KEYS = [
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_PASSWORD",
] as const;

/**
 * Return only absent login-shell bindings that could change effective startup
 * auth. The full shell plan also contains provider and channel credentials
 * that are outside this owner's deterministic pre-serve decision.
 */
export function resolveGatewayStartupAuthShellEnvMissingKeys(params: {
  inspection: GatewayStartupAuthInspection;
  missingKeys: readonly string[];
}): string[] {
  if (params.inspection.activeSecretRefPaths.length > 0) {
    return [];
  }
  const missing = new Set(params.missingKeys);
  const selected = (...keys: (typeof GATEWAY_AUTH_SHELL_ENV_KEYS)[number][]) =>
    keys.filter((key) => missing.has(key));
  const { auth, hasSharedSecret } = params.inspection;
  if (auth.modeSource === "default") {
    return selected(...GATEWAY_AUTH_SHELL_ENV_KEYS);
  }
  if (auth.modeSource === "token") {
    return selected("OPENCLAW_GATEWAY_PASSWORD");
  }
  if (auth.modeSource === "password") {
    return [];
  }
  if (auth.modeSource === "config" || auth.modeSource === "override") {
    if (auth.mode === "token") {
      return hasSharedSecret ? [] : selected("OPENCLAW_GATEWAY_TOKEN");
    }
    if (auth.mode === "password") {
      return hasSharedSecret ? [] : selected("OPENCLAW_GATEWAY_PASSWORD");
    }
    if (auth.mode === "trusted-proxy") {
      return auth.token ? [] : selected("OPENCLAW_GATEWAY_TOKEN");
    }
    return [];
  }
  return selected(...GATEWAY_AUTH_SHELL_ENV_KEYS);
}

export function shouldBlockGatewayBindWithoutExplicitAuth(params: {
  bindHost: string;
  hasSharedSecret: boolean;
  resolvedAuthMode: GatewayAuthConfig["mode"];
}): boolean {
  return (
    !isLoopbackHost(params.bindHost) &&
    !params.hasSharedSecret &&
    params.resolvedAuthMode !== "trusted-proxy"
  );
}

export type GatewayStartupBindAuthInspection = {
  mode: GatewayBindMode;
  status: "ready" | "blocked" | "indeterminate";
  reason?: string;
};

/** Inspect the bind/auth startup guard without probing a host or opening a socket. */
export function inspectGatewayStartupBindAuth(params: {
  bindMode: GatewayBindMode;
  customBindHost?: string;
  hasSharedSecret: boolean;
  resolvedAuthMode: GatewayAuthConfig["mode"];
  isContainer?: boolean;
}): GatewayStartupBindAuthInspection {
  const mode = params.bindMode;
  if (params.hasSharedSecret || params.resolvedAuthMode === "trusted-proxy") {
    return { mode, status: "ready" };
  }
  if (mode === "loopback") {
    return { mode, status: "ready" };
  }
  if (mode === "lan") {
    return { mode, status: "blocked" };
  }
  if (mode === "auto") {
    if (params.isContainer ?? isContainerEnvironment()) {
      return { mode, status: "blocked" };
    }
    return {
      mode,
      status: "indeterminate",
      reason:
        "Gateway bind mode auto requires a runtime availability probe to determine whether the effective host remains loopback.",
    };
  }
  if (mode === "custom") {
    const host = params.customBindHost?.trim() ?? "";
    if (!isValidIPv4(host) || !isLoopbackHost(host)) {
      return { mode, status: "blocked" };
    }
    return {
      mode,
      status: "indeterminate",
      reason:
        "Gateway custom loopback binding requires a runtime availability probe to determine whether startup falls back to an exposed host.",
    };
  }
  return {
    mode,
    status: "indeterminate",
    reason:
      "Gateway tailnet binding requires a runtime availability probe to determine the effective host.",
  };
}

/**
 * Inspect startup auth without resolving SecretRefs or generating credentials.
 * Direct startup may continue through unresolved refs, but cutover preflight
 * must report that state as indeterminate instead of guessing availability.
 */
export function inspectGatewayStartupAuth(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  authOverride?: GatewayAuthConfig;
  tailscaleOverride?: GatewayTailscaleConfig;
}): GatewayStartupAuthInspection {
  const env = params.env ?? process.env;
  const hasOverrides = Boolean(params.authOverride || params.tailscaleOverride);
  const effectiveConfig = hasOverrides
    ? {
        ...params.cfg,
        gateway: {
          ...params.cfg.gateway,
          auth: mergeGatewayAuthConfig(params.cfg.gateway?.auth, params.authOverride),
          tailscale: mergeGatewayTailscaleConfig(
            params.cfg.gateway?.tailscale,
            params.tailscaleOverride,
          ),
        },
      }
    : params.cfg;
  let explicitModeRequiredError: string | undefined;
  try {
    assertExplicitGatewayAuthModeWhenBothConfigured(params.cfg);
  } catch (error) {
    explicitModeRequiredError = error instanceof Error ? error.message : String(error);
  }
  const auth = resolveGatewayAuth({
    authConfig: effectiveConfig.gateway?.auth,
    env,
    tailscaleMode: effectiveConfig.gateway?.tailscale?.mode ?? "off",
  });
  const tokenConfigured =
    Boolean(normalizeOptionalString(auth.token)) ||
    hasConfiguredGatewayAuthSecretInput(effectiveConfig, "gateway.auth.token");
  const passwordConfigured =
    Boolean(normalizeOptionalString(auth.password)) ||
    hasConfiguredGatewayAuthSecretInput(effectiveConfig, "gateway.auth.password");
  const states = evaluateGatewayAuthSurfaceStates({
    config: effectiveConfig,
    env,
    defaults: effectiveConfig.secrets?.defaults,
  });
  const activeSecretRefPaths = GATEWAY_AUTH_SURFACE_PATHS.filter((path) => {
    const state = states[path];
    return state.active && state.hasSecretRef;
  });
  let knownWeakCredentialError: string | undefined;
  try {
    assertGatewayAuthNotKnownWeak(auth);
  } catch (error) {
    knownWeakCredentialError = error instanceof Error ? error.message : String(error);
  }
  const hasSharedSecret =
    (auth.mode === "token" && tokenConfigured) || (auth.mode === "password" && passwordConfigured);
  return {
    auth,
    hasSharedSecret,
    passwordMissing: auth.mode === "password" && !passwordConfigured,
    activeSecretRefPaths,
    ...(explicitModeRequiredError ? { explicitModeRequiredError } : {}),
    ...(knownWeakCredentialError ? { knownWeakCredentialError } : {}),
  };
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

function findActiveGatewaySharedSecret(auth: ResolvedGatewayAuth): string {
  if (auth.mode === "token") {
    return normalizeOptionalString(auth.token) ?? "";
  }
  if (auth.mode === "password" || auth.mode === "trusted-proxy") {
    return normalizeOptionalString(auth.password) ?? "";
  }
  return "";
}

function warnHooksTokenReuseGatewayAuth(params: {
  cfg: OpenClawConfig;
  auth: ResolvedGatewayAuth;
  warn?: (message: string) => void;
}): void {
  if (params.cfg.hooks?.enabled !== true || !params.warn) {
    return;
  }
  const hooksToken = normalizeOptionalString(params.cfg.hooks.token) ?? "";
  if (!hooksToken || hooksToken !== findActiveGatewaySharedSecret(params.auth)) {
    return;
  }
  params.warn(HOOKS_GATEWAY_AUTH_REUSE_WARNING);
}

/** Check every source that can satisfy token auth before startup generates one. */
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
  authOverride?: GatewayAuthConfig;
}): boolean {
  return (
    typeof params.authOverride?.password === "string" &&
    params.authOverride.password.trim().length > 0
  );
}

/** Ensure startup has effective Gateway auth, generating only an ephemeral token if needed. */
export async function ensureGatewayStartupAuth(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  authOverride?: GatewayAuthConfig;
  tailscaleOverride?: GatewayTailscaleConfig;
  warn?: (message: string) => void;
  /**
   * Legacy startup option retained for external callers. Startup-generated auth
   * is runtime-only; durable auth changes must go through explicit config tools.
   */
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
  const explicitMode = params.authOverride?.mode ?? params.cfg.gateway?.auth?.mode;
  // Resolve only refs that can satisfy the effective mode; inactive refs stay
  // as refs so startup does not require unrelated secret providers.
  const [resolvedTokenRefValue, resolvedPasswordRefValue] = await Promise.all([
    resolveGatewayTokenSecretRefValue({
      cfg: params.cfg,
      env,
      mode: explicitMode,
      hasTokenOverride: hasGatewayTokenOverrideCandidate({ authOverride: params.authOverride }),
      hasPasswordOverride: hasGatewayPasswordOverrideCandidate({
        authOverride: params.authOverride,
      }),
      hasTokenFallback: Boolean(trimToUndefined(env.OPENCLAW_GATEWAY_TOKEN)),
      hasPasswordFallback:
        Boolean(trimToUndefined(env.OPENCLAW_GATEWAY_PASSWORD)) ||
        hasConfiguredGatewayAuthSecretInput(params.cfg, "gateway.auth.password"),
    }),
    resolveGatewayPasswordSecretRefValue({
      cfg: params.cfg,
      env,
      mode: explicitMode,
      hasPasswordOverride: hasGatewayPasswordOverrideCandidate({
        authOverride: params.authOverride,
      }),
      hasTokenOverride: hasGatewayTokenOverrideCandidate({
        authOverride: params.authOverride,
      }),
      hasPasswordFallback: Boolean(trimToUndefined(env.OPENCLAW_GATEWAY_PASSWORD)),
      hasTokenFallback: hasGatewayTokenCandidate({
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
    assertGatewayAuthNotKnownWeak(resolved);
    warnHooksTokenReuseGatewayAuth({ cfg: params.cfg, auth: resolved, warn: params.warn });
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
  const nextAuth = resolveGatewayAuthFromConfig({
    cfg: nextCfg,
    env,
    authOverride: params.authOverride,
    tailscaleOverride: params.tailscaleOverride,
  });
  // The generated token is crypto-random, so this cannot match the weak set
  // in practice — but running the assertion on both branches documents that
  // the rule applies uniformly and guards against any future path that might
  // feed a non-generated value through nextAuth.
  assertGatewayAuthNotKnownWeak(nextAuth);
  warnHooksTokenReuseGatewayAuth({ cfg: nextCfg, auth: nextAuth, warn: params.warn });
  return {
    cfg: nextCfg,
    auth: nextAuth,
    generatedToken,
    persistedGeneratedToken: false,
  };
}
