import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createGatewayCredentialPlan,
  type GatewayCredentialPlan,
  trimCredentialToUndefined,
  trimToUndefined,
} from "./credential-planner.js";
export {
  hasGatewayPasswordEnvCandidate,
  hasGatewayTokenEnvCandidate,
  trimCredentialToUndefined,
  trimToUndefined,
} from "./credential-planner.js";

export type ExplicitGatewayAuth = {
  token?: string;
  password?: string;
};

export type ResolvedGatewayCredentials = {
  token?: string;
  password?: string;
};

export type GatewayCredentialMode = "local" | "remote";
export type GatewayCredentialPrecedence = "env-first" | "config-first";
export type GatewayRemoteCredentialPrecedence = "remote-first" | "env-first";
export type GatewayRemoteCredentialFallback = "remote-env-local" | "remote-only";

const GATEWAY_SECRET_REF_UNAVAILABLE_ERROR_CODE = "GATEWAY_SECRET_REF_UNAVAILABLE"; // pragma: allowlist secret

export class GatewaySecretRefUnavailableError extends Error {
  readonly code = GATEWAY_SECRET_REF_UNAVAILABLE_ERROR_CODE;
  readonly path: string;

  constructor(path: string) {
    super(
      [
        `${path} is configured as a secret reference but is unavailable in this command path.`,
        "Fix: set OPENCLAW_GATEWAY_TOKEN/OPENCLAW_GATEWAY_PASSWORD, pass explicit --token/--password,",
        "or run a gateway command path that resolves secret references before credential selection.",
      ].join("\n"),
    );
    this.name = "GatewaySecretRefUnavailableError";
    this.path = path;
  }
}

export function isGatewaySecretRefUnavailableError(
  error: unknown,
  expectedPath?: string,
): error is GatewaySecretRefUnavailableError {
  if (!(error instanceof GatewaySecretRefUnavailableError)) {
    return false;
  }
  if (!expectedPath) {
    return true;
  }
  return error.path === expectedPath;
}

function firstDefined(values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value) {
      return value;
    }
  }
  return undefined;
}

function throwUnresolvedGatewaySecretInput(path: string): never {
  throw new GatewaySecretRefUnavailableError(path);
}

export function resolveGatewayCredentialsFromValues(params: {
  configToken?: unknown;
  configPassword?: unknown;
  env?: NodeJS.ProcessEnv;
  tokenPrecedence?: GatewayCredentialPrecedence;
  passwordPrecedence?: GatewayCredentialPrecedence;
}): ResolvedGatewayCredentials {
  const env = params.env ?? process.env;
  const envToken = trimToUndefined(env.OPENCLAW_GATEWAY_TOKEN);
  const envPassword = trimToUndefined(env.OPENCLAW_GATEWAY_PASSWORD);
  const configToken = trimCredentialToUndefined(params.configToken);
  const configPassword = trimCredentialToUndefined(params.configPassword);
  const tokenPrecedence = params.tokenPrecedence ?? "env-first";
  const passwordPrecedence = params.passwordPrecedence ?? "env-first";

  const token =
    tokenPrecedence === "config-first"
      ? firstDefined([configToken, envToken])
      : firstDefined([envToken, configToken]);
  const password =
    passwordPrecedence === "config-first" // pragma: allowlist secret
      ? firstDefined([configPassword, envPassword])
      : firstDefined([envPassword, configPassword]);

  return { token, password };
}

function resolveLocalGatewayCredentials(params: {
  plan: GatewayCredentialPlan;
  env: NodeJS.ProcessEnv;
  localTokenPrecedence: GatewayCredentialPrecedence;
  localPasswordPrecedence: GatewayCredentialPrecedence;
}): ResolvedGatewayCredentials {
  const fallbackToken = params.plan.localToken.configured
    ? params.plan.localToken.value
    : params.plan.remoteToken.value;
  const fallbackPassword = params.plan.localPassword.configured
    ? params.plan.localPassword.value
    : params.plan.remotePassword.value;
  const localResolved = resolveGatewayCredentialsFromValues({
    configToken: fallbackToken,
    configPassword: fallbackPassword,
    env: params.env,
    tokenPrecedence: params.localTokenPrecedence,
    passwordPrecedence: params.localPasswordPrecedence,
  });
  const localPasswordCanWin =
    params.plan.authMode === "password" ||
    (params.plan.authMode !== "token" &&
      params.plan.authMode !== "none" &&
      params.plan.authMode !== "trusted-proxy" &&
      !localResolved.token);
  const localTokenCanWin =
    params.plan.authMode === "token" ||
    (params.plan.authMode !== "password" &&
      params.plan.authMode !== "none" &&
      params.plan.authMode !== "trusted-proxy" &&
      !localResolved.password);

  if (
    params.plan.localToken.refPath &&
    params.localTokenPrecedence === "config-first" &&
    !params.plan.localToken.value &&
    Boolean(params.plan.envToken) &&
    localTokenCanWin
  ) {
    throwUnresolvedGatewaySecretInput(params.plan.localToken.refPath);
  }
  if (
    params.plan.localPassword.refPath &&
    params.localPasswordPrecedence === "config-first" && // pragma: allowlist secret
    !params.plan.localPassword.value &&
    Boolean(params.plan.envPassword) &&
    localPasswordCanWin
  ) {
    throwUnresolvedGatewaySecretInput(params.plan.localPassword.refPath);
  }
  if (
    params.plan.localToken.refPath &&
    !localResolved.token &&
    !params.plan.envToken &&
    localTokenCanWin
  ) {
    throwUnresolvedGatewaySecretInput(params.plan.localToken.refPath);
  }
  if (
    params.plan.localPassword.refPath &&
    !localResolved.password &&
    !params.plan.envPassword &&
    localPasswordCanWin
  ) {
    throwUnresolvedGatewaySecretInput(params.plan.localPassword.refPath);
  }
  return localResolved;
}

function resolveRemoteGatewayCredentials(params: {
  plan: GatewayCredentialPlan;
  remoteTokenPrecedence: GatewayRemoteCredentialPrecedence;
  remotePasswordPrecedence: GatewayRemoteCredentialPrecedence;
  remoteTokenFallback: GatewayRemoteCredentialFallback;
  remotePasswordFallback: GatewayRemoteCredentialFallback;
}): ResolvedGatewayCredentials {
  const token =
    params.remoteTokenFallback === "remote-only"
      ? params.plan.remoteToken.value
      : params.remoteTokenPrecedence === "env-first"
        ? firstDefined([
            params.plan.envToken,
            params.plan.remoteToken.value,
            params.plan.localToken.value,
          ])
        : firstDefined([
            params.plan.remoteToken.value,
            params.plan.envToken,
            params.plan.localToken.value,
          ]);
  const password =
    params.remotePasswordFallback === "remote-only" // pragma: allowlist secret
      ? params.plan.remotePassword.value
      : params.remotePasswordPrecedence === "env-first" // pragma: allowlist secret
        ? firstDefined([
            params.plan.envPassword,
            params.plan.remotePassword.value,
            params.plan.localPassword.value,
          ])
        : firstDefined([
            params.plan.remotePassword.value,
            params.plan.envPassword,
            params.plan.localPassword.value,
          ]);
  const localTokenFallbackEnabled = params.remoteTokenFallback !== "remote-only";
  const localTokenFallback =
    params.remoteTokenFallback === "remote-only" ? undefined : params.plan.localToken.value;
  const localPasswordFallback =
    params.remotePasswordFallback === "remote-only" ? undefined : params.plan.localPassword.value; // pragma: allowlist secret

  if (
    params.plan.remoteToken.refPath &&
    !token &&
    !params.plan.envToken &&
    !localTokenFallback &&
    !password
  ) {
    throwUnresolvedGatewaySecretInput(params.plan.remoteToken.refPath);
  }
  if (
    params.plan.remotePassword.refPath &&
    !password &&
    !params.plan.envPassword &&
    !localPasswordFallback &&
    !token
  ) {
    throwUnresolvedGatewaySecretInput(params.plan.remotePassword.refPath);
  }
  if (
    params.plan.localToken.refPath &&
    localTokenFallbackEnabled &&
    !token &&
    !password &&
    !params.plan.envToken &&
    !params.plan.remoteToken.value &&
    params.plan.localTokenCanWin
  ) {
    throwUnresolvedGatewaySecretInput(params.plan.localToken.refPath);
  }

  return { token, password };
}

export function resolveGatewayCredentialsFromConfig(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  explicitAuth?: ExplicitGatewayAuth;
  urlOverride?: string;
  urlOverrideSource?: "cli" | "env";
  modeOverride?: GatewayCredentialMode;
  localTokenPrecedence?: GatewayCredentialPrecedence;
  localPasswordPrecedence?: GatewayCredentialPrecedence;
  remoteTokenPrecedence?: GatewayRemoteCredentialPrecedence;
  remotePasswordPrecedence?: GatewayRemoteCredentialPrecedence;
  remoteTokenFallback?: GatewayRemoteCredentialFallback;
  remotePasswordFallback?: GatewayRemoteCredentialFallback;
}): ResolvedGatewayCredentials {
  const env = params.env ?? process.env;
  const explicitToken = trimToUndefined(params.explicitAuth?.token);
  const explicitPassword = trimToUndefined(params.explicitAuth?.password);
  if (explicitToken || explicitPassword) {
    return { token: explicitToken, password: explicitPassword };
  }
  if (trimToUndefined(params.urlOverride) && params.urlOverrideSource !== "env") {
    return {};
  }
  if (trimToUndefined(params.urlOverride) && params.urlOverrideSource === "env") {
    return resolveGatewayCredentialsFromValues({
      configToken: undefined,
      configPassword: undefined,
      env,
      tokenPrecedence: "env-first",
      passwordPrecedence: "env-first", // pragma: allowlist secret
    });
  }

  const plan = createGatewayCredentialPlan({
    config: params.cfg,
    env,
  });
  const mode: GatewayCredentialMode = params.modeOverride ?? plan.configuredMode;

  const localTokenPrecedence =
    params.localTokenPrecedence ??
    (env.OPENCLAW_SERVICE_KIND === "gateway" ? "config-first" : "env-first");
  const localPasswordPrecedence = params.localPasswordPrecedence ?? "env-first";

  if (mode === "local") {
    return resolveLocalGatewayCredentials({
      plan,
      env,
      localTokenPrecedence,
      localPasswordPrecedence,
    });
  }

  const remoteTokenFallback = params.remoteTokenFallback ?? "remote-env-local";
  const remotePasswordFallback = params.remotePasswordFallback ?? "remote-env-local";
  const remoteTokenPrecedence = params.remoteTokenPrecedence ?? "remote-first";
  const remotePasswordPrecedence = params.remotePasswordPrecedence ?? "env-first";

  return resolveRemoteGatewayCredentials({
    plan,
    remoteTokenPrecedence,
    remotePasswordPrecedence,
    remoteTokenFallback,
    remotePasswordFallback,
  });
}

export function resolveGatewayProbeCredentialsFromConfig(params: {
  cfg: OpenClawConfig;
  mode: GatewayCredentialMode;
  env?: NodeJS.ProcessEnv;
  explicitAuth?: ExplicitGatewayAuth;
}): ResolvedGatewayCredentials {
  return resolveGatewayCredentialsFromConfig({
    cfg: params.cfg,
    env: params.env,
    explicitAuth: params.explicitAuth,
    modeOverride: params.mode,
    remoteTokenFallback: "remote-only",
  });
}

export function resolveGatewayDriftCheckCredentialsFromConfig(params: {
  cfg: OpenClawConfig;
}): ResolvedGatewayCredentials {
  return resolveGatewayCredentialsFromConfig({
    cfg: params.cfg,
    env: {} as NodeJS.ProcessEnv,
    modeOverride: "local",
    localTokenPrecedence: "config-first",
  });
}
