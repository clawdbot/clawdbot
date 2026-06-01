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
  trimToUndefined,
} from "./credential-planner.js";

export type ExplicitGatewayAuth = {
  token?: string;
  password?: string;
};

type ResolvedGatewayCredentials = {
  token?: string;
  password?: string;
};

/** Selects local Gateway credentials or remote Gateway client credentials. */
export type GatewayCredentialMode = "local" | "remote";

/** Chooses whether environment credentials or config credentials win for local auth. */
export type GatewayCredentialPrecedence = "env-first" | "config-first";

/** Chooses whether remote config or environment credentials win for remote client auth. */
export type GatewayRemoteCredentialPrecedence = "remote-first" | "env-first";

/** Controls whether remote client auth may fall back to env/local credentials. */
export type GatewayRemoteCredentialFallback = "remote-env-local" | "remote-only";

const GATEWAY_SECRET_REF_UNAVAILABLE_ERROR_CODE = "GATEWAY_SECRET_REF_UNAVAILABLE"; // pragma: allowlist secret

/** Raised when a command path needs Gateway credentials before secret refs were resolved. */
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

/** Type guard for unresolved Gateway secret-ref errors, optionally scoped to a config path. */
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

/** Resolve direct token/password values with caller-selected env-vs-config precedence. */
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
    : params.plan.authMode === "trusted-proxy"
      ? undefined
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
    params.plan.authMode === "trusted-proxy" ||
    (params.plan.authMode !== "token" && params.plan.authMode !== "none" && !localResolved.token);
  const localTokenCanWin =
    params.plan.authMode === "token" ||
    (params.plan.authMode !== "password" &&
      params.plan.authMode !== "none" &&
      params.plan.authMode !== "trusted-proxy" &&
      !localResolved.password);

  // Config-first callers must not let an env fallback mask a configured but
  // unresolved secret ref that would otherwise be the active local credential.
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

  // Remote-only probe paths intentionally ignore local fallback credentials;
  // normal remote clients keep them as a last resort for older local config.
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

/** Resolve Gateway credentials from config, explicit auth, URL overrides, and mode policy. */
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
  // A CLI URL override points at an ad-hoc Gateway, so stored credentials for
  // the configured Gateway must not leak into that request.
  if (trimToUndefined(params.urlOverride) && params.urlOverrideSource !== "env") {
    return {};
  }
  // Env URL overrides keep env credentials paired with the same environment.
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

/** Resolve the stricter credential view used by Gateway probe paths. */
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
