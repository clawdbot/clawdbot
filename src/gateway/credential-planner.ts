import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import { containsEnvVarReference } from "../config/env-substitution.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasConfiguredSecretInput, resolveSecretInputRef } from "../config/types.secrets.js";

type GatewayCredentialInputPath =
  | "gateway.auth.token"
  | "gateway.auth.password"
  | "gateway.remote.token"
  | "gateway.remote.password";

type GatewayConfiguredCredentialInput = {
  path: GatewayCredentialInputPath;
  configured: boolean;
  value?: string;
  refPath?: GatewayCredentialInputPath;
  hasSecretRef: boolean;
};

/** Precomputed Gateway credential surfaces used by startup, secret resolution, and clients. */
export type GatewayCredentialPlan = {
  configuredMode: "local" | "remote";
  authMode?: string;
  envToken?: string;
  envPassword?: string;
  localToken: GatewayConfiguredCredentialInput;
  localPassword: GatewayConfiguredCredentialInput;
  remoteToken: GatewayConfiguredCredentialInput;
  remotePassword: GatewayConfiguredCredentialInput;
  localTokenCanWin: boolean;
  localPasswordCanWin: boolean;
  localTokenSurfaceActive: boolean;
  tokenCanWin: boolean;
  passwordCanWin: boolean;
  remoteMode: boolean;
  remoteUrlConfigured: boolean;
  tailscaleRemoteExposure: boolean;
  remoteConfiguredSurface: boolean;
  remoteTokenFallbackActive: boolean;
  remoteTokenActive: boolean;
  remotePasswordFallbackActive: boolean;
  remotePasswordActive: boolean;
};

type GatewaySecretDefaults = NonNullable<OpenClawConfig["secrets"]>["defaults"];

/** Normalize optional Gateway credential strings to nonempty values. */
export const trimToUndefined = normalizeOptionalString;

/**
 * Like trimToUndefined but also rejects unresolved env var placeholders (e.g. `${VAR}`).
 * This prevents literal placeholder strings like `${OPENCLAW_GATEWAY_TOKEN}` from being
 * accepted as valid credentials when the referenced env var is missing.
 * Note: legitimate credential values containing literal `${UPPER_CASE}` patterns will
 * also be rejected, but this is an extremely unlikely edge case.
 */
export function trimCredentialToUndefined(value: unknown): string | undefined {
  const trimmed = trimToUndefined(value);
  if (trimmed && containsEnvVarReference(trimmed)) {
    return undefined;
  }
  return trimmed;
}

/** True when the process env supplies a nonempty Gateway token candidate. */
export function hasGatewayTokenEnvCandidate(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(trimToUndefined(env.OPENCLAW_GATEWAY_TOKEN));
}

/** True when the process env supplies a nonempty Gateway password candidate. */
export function hasGatewayPasswordEnvCandidate(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(trimToUndefined(env.OPENCLAW_GATEWAY_PASSWORD));
}

/** Classify one configured credential input without resolving secret refs. */
function resolveConfiguredGatewayCredentialInput(params: {
  value: unknown;
  defaults?: GatewaySecretDefaults;
  path: GatewayCredentialInputPath;
}): GatewayConfiguredCredentialInput {
  const ref = resolveSecretInputRef({
    value: params.value,
    defaults: params.defaults,
  }).ref;
  return {
    path: params.path,
    configured: hasConfiguredSecretInput(params.value, params.defaults),
    value: ref ? undefined : trimToUndefined(params.value),
    refPath: ref ? params.path : undefined,
    hasSecretRef: ref !== null,
  };
}

/** Build the shared credential plan for Gateway startup, local auth, and remote client auth. */
export function createGatewayCredentialPlan(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  defaults?: GatewaySecretDefaults;
}): GatewayCredentialPlan {
  const env = params.env ?? process.env;
  const gateway = params.config.gateway;
  const remote = gateway?.remote;
  const defaults = params.defaults ?? params.config.secrets?.defaults;
  const authMode = gateway?.auth?.mode;
  const envToken = trimToUndefined(env.OPENCLAW_GATEWAY_TOKEN);
  const envPassword = trimToUndefined(env.OPENCLAW_GATEWAY_PASSWORD);

  const localToken = resolveConfiguredGatewayCredentialInput({
    value: gateway?.auth?.token,
    defaults,
    path: "gateway.auth.token",
  });
  const localPassword = resolveConfiguredGatewayCredentialInput({
    value: gateway?.auth?.password,
    defaults,
    path: "gateway.auth.password",
  });
  const remoteToken = resolveConfiguredGatewayCredentialInput({
    value: remote?.token,
    defaults,
    path: "gateway.remote.token",
  });
  const remotePassword = resolveConfiguredGatewayCredentialInput({
    value: remote?.password,
    defaults,
    path: "gateway.remote.password",
  });

  // The local token surface is disabled by password/none/trusted-proxy modes so
  // token refs do not get resolved for auth modes that cannot consume them.
  const localTokenCanWin =
    authMode !== "password" && authMode !== "none" && authMode !== "trusted-proxy";
  const tokenCanWin = Boolean(envToken || localToken.configured || remoteToken.configured);
  const passwordCanWin =
    authMode === "password" ||
    authMode === "trusted-proxy" ||
    (authMode !== "token" && authMode !== "none" && !tokenCanWin);
  const localTokenSurfaceActive =
    localTokenCanWin &&
    !envToken &&
    (authMode === "token" ||
      (authMode === undefined && !(envPassword || localPassword.configured)));

  const remoteMode = gateway?.mode === "remote";
  const remoteUrlConfigured = Boolean(trimToUndefined(remote?.url));
  const tailscaleRemoteExposure =
    gateway?.tailscale?.mode === "serve" || gateway?.tailscale?.mode === "funnel";
  const remoteConfiguredSurface = remoteMode || remoteUrlConfigured || tailscaleRemoteExposure;
  // Remote credentials may borrow local auth credentials only when the remote
  // surface exists but no explicit remote/env candidate can satisfy the mode.
  const remoteTokenFallbackActive = localTokenCanWin && !envToken && !localToken.configured;
  const remotePasswordFallbackActive =
    authMode !== "trusted-proxy" && !envPassword && !localPassword.configured && passwordCanWin;

  return {
    configuredMode: gateway?.mode === "remote" ? "remote" : "local",
    authMode,
    envToken,
    envPassword,
    localToken,
    localPassword,
    remoteToken,
    remotePassword,
    localTokenCanWin,
    localPasswordCanWin: passwordCanWin,
    localTokenSurfaceActive,
    tokenCanWin,
    passwordCanWin,
    remoteMode,
    remoteUrlConfigured,
    tailscaleRemoteExposure,
    remoteConfiguredSurface,
    remoteTokenFallbackActive,
    remoteTokenActive: remoteConfiguredSurface || remoteTokenFallbackActive,
    remotePasswordFallbackActive,
    remotePasswordActive: remoteConfiguredSurface || remotePasswordFallbackActive,
  };
}
