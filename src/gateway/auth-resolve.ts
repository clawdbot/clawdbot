// Gateway auth resolver.
// Combines configured auth, overrides, environment credentials, and Tailscale policy.
import { copyConfigResolutionFactsExcept } from "../config/resolution-facts.js";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type {
  GatewayAuthConfig,
  GatewayTailscaleMode,
  GatewayTrustedProxyConfig,
} from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { createGatewayCredentialPlan } from "./credential-planner.js";
import { resolveGatewayCredentialsFromValues } from "./credentials.js";

/** Authentication modes after config, override, and credential inputs are combined. */
type ResolvedGatewayAuthMode = "none" | "token" | "password" | "trusted-proxy";

/** Records which input selected the effective Gateway auth mode. */
type ResolvedGatewayAuthModeSource = "override" | "config" | "password" | "token" | "default";

/** Fully resolved Gateway auth policy before startup validates required secrets. */
export type ResolvedGatewayAuth = {
  mode: ResolvedGatewayAuthMode;
  modeSource?: ResolvedGatewayAuthModeSource;
  token?: string;
  password?: string;
  allowTailscale: boolean;
  trustedProxy?: GatewayTrustedProxyConfig;
};

function mergeGatewayAuthConfig(
  base: GatewayAuthConfig | null | undefined,
  override: GatewayAuthConfig | null | undefined,
): GatewayAuthConfig {
  const merged = { ...base };
  if (!override) {
    return merged;
  }
  for (const key of [
    "mode",
    "token",
    "password",
    "allowTailscale",
    "rateLimit",
    "trustedProxy",
  ] as const) {
    if (override[key] !== undefined) {
      Object.assign(merged, { [key]: override[key] });
    }
  }
  return merged;
}

function finalizeResolvedGatewayAuth(params: {
  authConfig: GatewayAuthConfig;
  authOverride?: GatewayAuthConfig;
  token?: string;
  password?: string;
  tailscaleMode?: GatewayTailscaleMode;
}): ResolvedGatewayAuth {
  const { authConfig, authOverride, token, password } = params;
  const mode =
    authOverride?.mode ?? authConfig.mode ?? (password ? "password" : token ? "token" : "token");
  const modeSource =
    authOverride?.mode !== undefined
      ? "override"
      : authConfig.mode
        ? "config"
        : password
          ? "password"
          : token
            ? "token"
            : "default";
  return {
    mode,
    modeSource,
    token,
    password,
    allowTailscale:
      authConfig.allowTailscale ??
      (params.tailscaleMode === "serve" && mode !== "password" && mode !== "trusted-proxy"),
    trustedProxy: authConfig.trustedProxy,
  };
}

/** Resolve Gateway auth mode, credentials, trusted-proxy policy, and Tailscale allowance. */
export function resolveGatewayAuth(params: {
  authConfig?: GatewayAuthConfig | null;
  authOverride?: GatewayAuthConfig | null;
  env?: NodeJS.ProcessEnv;
  tailscaleMode?: GatewayTailscaleMode;
}): ResolvedGatewayAuth {
  const runtimeConfig = getRuntimeConfigSnapshot();
  if (runtimeConfig && runtimeConfig.gateway?.auth === params.authConfig) {
    return resolveGatewayAuthForConfig({
      config: runtimeConfig,
      authOverride: params.authOverride,
      env: params.env,
      tailscaleMode: params.tailscaleMode,
    });
  }
  const authOverride = params.authOverride ?? undefined;
  const authConfig = mergeGatewayAuthConfig(params.authConfig, authOverride);
  const env = params.env ?? process.env;
  const tokenRef = resolveSecretInputRef({ value: authConfig.token }).ref;
  const passwordRef = resolveSecretInputRef({ value: authConfig.password }).ref;
  // Secret refs are not plaintext credentials here. Startup/runtime secret
  // resolution validates active refs before request authorization sees them.
  const resolvedCredentials = resolveGatewayCredentialsFromValues({
    configToken: tokenRef ? undefined : authConfig.token,
    configPassword: passwordRef ? undefined : authConfig.password,
    env,
    tokenPrecedence: "config-first",
    passwordPrecedence: "config-first", // pragma: allowlist secret
  });
  return finalizeResolvedGatewayAuth({
    authConfig,
    authOverride,
    token: resolvedCredentials.token,
    password: resolvedCredentials.password,
    tailscaleMode: params.tailscaleMode,
  });
}

/** Credential edits may reload only while their resolved authentication mode stays fixed. */
export function canHotReloadGatewayAuthCredentials(
  previousConfig: OpenClawConfig | undefined,
  candidateConfig: OpenClawConfig | undefined,
): boolean {
  if (!previousConfig || !candidateConfig) {
    return false;
  }
  const modes = [previousConfig, candidateConfig].map((config) => {
    const authConfig = config.gateway?.auth;
    // Raw SecretRefs cannot establish an inferred mode before secret preparation.
    if (
      !authConfig?.mode &&
      (resolveSecretInputRef({ value: authConfig?.token }).ref ||
        resolveSecretInputRef({ value: authConfig?.password }).ref)
    ) {
      return undefined;
    }
    return resolveGatewayAuth({ authConfig, tailscaleMode: config.gateway?.tailscale?.mode }).mode;
  });
  return (modes[0] === "token" || modes[0] === "password") && modes[0] === modes[1];
}

/** Resolve auth from an env-substituted config while retaining its resolution facts. */
export function resolveGatewayAuthForConfig(params: {
  config: OpenClawConfig;
  authOverride?: GatewayAuthConfig | null;
  env?: NodeJS.ProcessEnv;
  tailscaleMode?: GatewayTailscaleMode;
}): ResolvedGatewayAuth {
  const authOverride = params.authOverride ?? undefined;
  const authConfig = mergeGatewayAuthConfig(params.config.gateway?.auth, authOverride);
  const config = {
    ...params.config,
    gateway: { ...params.config.gateway, auth: authConfig },
  };
  const overriddenPaths = [
    ...(authOverride?.token !== undefined ? ["gateway.auth.token"] : []),
    ...(authOverride?.password !== undefined ? ["gateway.auth.password"] : []),
  ];
  copyConfigResolutionFactsExcept(params.config, config, overriddenPaths);
  const plan = createGatewayCredentialPlan({ config, env: params.env });
  const token = plan.localToken.hasSecretRef
    ? undefined
    : (plan.localToken.value ?? plan.envToken ?? plan.remoteToken.value);
  const password = plan.localPassword.hasSecretRef
    ? undefined
    : (plan.localPassword.value ??
      plan.envPassword ??
      (plan.authMode === "trusted-proxy" ? undefined : plan.remotePassword.value));
  return finalizeResolvedGatewayAuth({
    authConfig,
    authOverride,
    token,
    password,
    tailscaleMode: params.tailscaleMode,
  });
}
