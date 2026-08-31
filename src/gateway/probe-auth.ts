// Gateway probe auth resolver.
// Adapts gateway credential precedence for local/remote reachability checks.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayProbeSurfaceAuth } from "./auth-surface-resolution.js";
import { createGatewayCredentialPlan } from "./credential-planner.js";
import { resolveGatewayCredentialsWithSecretInputs } from "./credentials-secret-inputs.js";
import {
  type ExplicitGatewayAuth,
  type GatewayCredentialPrecedence,
  isGatewaySecretRefUnavailableError,
  resolveGatewayProbeCredentialsFromConfig,
} from "./credentials.js";
export { resolveGatewayProbeTarget } from "./probe-target.js";
export type { GatewayProbeTargetResolution } from "./probe-target.js";

type GatewayProbeCredentialParams = {
  cfg: OpenClawConfig;
  mode: "local" | "remote";
  env?: NodeJS.ProcessEnv;
  explicitAuth?: ExplicitGatewayAuth;
  urlOverride?: string;
  urlOverrideSource?: "cli" | "env";
  localPrecedence?: GatewayCredentialPrecedence;
};

// Probe auth adapts normal gateway credential precedence for reachability
// checks. Local probes must not accidentally consume remote gateway credentials
// from config when they are only checking the embedded/local gateway.
function buildGatewayProbeCredentialPolicy(params: GatewayProbeCredentialParams) {
  const cfg = resolveGatewayProbeCredentialConfig(params);
  const plan =
    params.mode === "local" && params.localPrecedence === "env-first"
      ? createGatewayCredentialPlan({ config: cfg, env: params.env })
      : undefined;
  const activeLocalRef =
    (plan?.localTokenCanWin && plan.localToken.hasSecretRef) ||
    ((plan?.localPasswordCanWin || plan?.authMode === undefined) &&
      plan?.localPassword.hasSecretRef);
  return {
    activeLocalRef,
    config: cfg,
    cfg,
    env: params.env,
    explicitAuth: params.explicitAuth,
    urlOverride: params.urlOverride,
    urlOverrideSource: params.urlOverrideSource,
    modeOverride: params.mode,
    mode: params.mode,
    // Env-first is historical for plaintext, but an active SecretRef is an
    // explicit trust choice and must never be bypassed by ambient credentials.
    localPrecedence: activeLocalRef ? ("config-first" as const) : params.localPrecedence,
    remoteTokenFallback: "remote-only" as const,
  };
}

export function resolveGatewayProbeCredentialConfig(params: {
  cfg: OpenClawConfig;
  mode: "local" | "remote";
}): OpenClawConfig {
  const gateway = params.cfg.gateway;
  const credentials = params.mode === "local" ? gateway?.remote : gateway?.auth;
  if (!credentials || (credentials.token === undefined && credentials.password === undefined)) {
    return params.cfg;
  }

  // A probe may only use credentials owned by its target surface. Otherwise a
  // healthy result can both target the wrong Gateway and disclose its peer's secret.
  const credentialsWithoutAuth = { ...credentials };
  delete credentialsWithoutAuth.token;
  delete credentialsWithoutAuth.password;
  return {
    ...params.cfg,
    gateway: {
      ...gateway,
      ...(params.mode === "local"
        ? { remote: credentialsWithoutAuth }
        : { auth: credentialsWithoutAuth }),
    },
  };
}

function resolveExplicitProbeAuth(explicitAuth?: ExplicitGatewayAuth): {
  token?: string;
  password?: string;
} {
  const token = normalizeOptionalString(explicitAuth?.token);
  const password = normalizeOptionalString(explicitAuth?.password);
  return { token, password };
}

function hasExplicitProbeAuth(auth: { token?: string; password?: string }): boolean {
  return Boolean(auth.token || auth.password);
}

function buildUnresolvedProbeAuthWarning(path: string): string {
  return `${path} SecretRef is unresolved in this command path; probing without configured auth credentials.`;
}

function resolveGatewayProbeWarning(error: unknown): string | undefined {
  if (!isGatewaySecretRefUnavailableError(error)) {
    throw error;
  }
  return buildUnresolvedProbeAuthWarning(error.path);
}

/** Resolves synchronous probe auth, throwing when configured secrets cannot be read. */
export function resolveGatewayProbeAuth(params: {
  cfg: OpenClawConfig;
  mode: "local" | "remote";
  env?: NodeJS.ProcessEnv;
  urlOverride?: string;
  urlOverrideSource?: "cli" | "env";
}): { token?: string; password?: string } {
  const policy = buildGatewayProbeCredentialPolicy(params);
  return resolveGatewayProbeCredentialsFromConfig(policy);
}

async function resolveGatewayProbeAuthResolutionWithSecretInputs(
  params: GatewayProbeCredentialParams,
): Promise<{
  auth: { token?: string; password?: string };
  warning?: string;
}> {
  const policy = buildGatewayProbeCredentialPolicy(params);
  const explicitAuth = resolveExplicitProbeAuth(params.explicitAuth);
  if (
    (params.mode === "remote" || policy.activeLocalRef) &&
    !hasExplicitProbeAuth(explicitAuth) &&
    !normalizeOptionalString(params.urlOverride)
  ) {
    // Remote and SecretRef-owned local probes must share their target's
    // credential owner so ambient auth cannot mask the configured secret.
    const resolved = await resolveGatewayProbeSurfaceAuth({
      config: policy.config,
      env: policy.env,
      surface: params.mode,
    });
    const warning = resolved.diagnostics?.join("\n");
    if (warning) {
      // Keep a resolved sibling config credential, never ambient fallback.
      return {
        auth:
          resolved.source === "config"
            ? { token: resolved.token, password: resolved.password }
            : {},
        warning,
      };
    }
    return {
      auth: { token: resolved.token, password: resolved.password },
    };
  }
  const auth = await resolveGatewayCredentialsWithSecretInputs({
    config: policy.config,
    env: policy.env,
    explicitAuth: policy.explicitAuth,
    urlOverride: policy.urlOverride,
    urlOverrideSource: policy.urlOverrideSource,
    modeOverride: policy.modeOverride,
    localPrecedence: policy.localPrecedence,
    remoteTokenFallback: policy.remoteTokenFallback,
  });
  return { auth };
}

/** Resolves probe auth with async SecretRef support. */
export async function resolveGatewayProbeAuthWithSecretInputs(
  params: GatewayProbeCredentialParams,
): Promise<{ token?: string; password?: string }> {
  return (await resolveGatewayProbeAuthResolutionWithSecretInputs(params)).auth;
}

/** Resolves probe auth without throwing for unavailable SecretRefs, returning a warning. */
export async function resolveGatewayProbeAuthSafeWithSecretInputs(
  params: GatewayProbeCredentialParams,
): Promise<{
  auth: { token?: string; password?: string };
  warning?: string;
}> {
  const explicitAuth = resolveExplicitProbeAuth(params.explicitAuth);
  if (hasExplicitProbeAuth(explicitAuth)) {
    return {
      auth: explicitAuth,
    };
  }

  try {
    return await resolveGatewayProbeAuthResolutionWithSecretInputs(params);
  } catch (error) {
    return {
      auth: {},
      warning: resolveGatewayProbeWarning(error),
    };
  }
}

/** Synchronous safe probe auth wrapper for config-only credential paths. */
export function resolveGatewayProbeAuthSafe(params: {
  cfg: OpenClawConfig;
  mode: "local" | "remote";
  env?: NodeJS.ProcessEnv;
  explicitAuth?: ExplicitGatewayAuth;
  urlOverride?: string;
  urlOverrideSource?: "cli" | "env";
}): {
  auth: { token?: string; password?: string };
  warning?: string;
} {
  const explicitAuth = resolveExplicitProbeAuth(params.explicitAuth);
  if (hasExplicitProbeAuth(explicitAuth)) {
    return {
      auth: explicitAuth,
    };
  }

  try {
    return { auth: resolveGatewayProbeAuth(params) };
  } catch (error) {
    return {
      auth: {},
      warning: resolveGatewayProbeWarning(error),
    };
  }
}
