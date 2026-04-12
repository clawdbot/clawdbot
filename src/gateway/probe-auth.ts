import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveGatewayCredentialsWithSecretInputs } from "./credentials-secret-inputs.js";
import {
  type ExplicitGatewayAuth,
  isGatewaySecretRefUnavailableError,
  resolveGatewayProbeCredentialsFromConfig,
} from "./credentials.js";
export { resolveGatewayProbeTarget } from "./probe-target.js";
export type { GatewayProbeTargetResolution } from "./probe-target.js";

function buildGatewayProbeCredentialPolicy(params: {
  cfg: OpenClawConfig;
  mode: "local" | "remote";
  env?: NodeJS.ProcessEnv;
  explicitAuth?: ExplicitGatewayAuth;
}) {
  return {
    config: params.cfg,
    cfg: params.cfg,
    env: params.env,
    explicitAuth: params.explicitAuth,
    modeOverride: params.mode,
    mode: params.mode,
    remoteTokenFallback: "remote-only" as const,
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

export function resolveGatewayProbeAuth(params: {
  cfg: OpenClawConfig;
  mode: "local" | "remote";
  env?: NodeJS.ProcessEnv;
}): { token?: string; password?: string } {
  const policy = buildGatewayProbeCredentialPolicy(params);
  return resolveGatewayProbeCredentialsFromConfig(policy);
}

export async function resolveGatewayProbeAuthWithSecretInputs(params: {
  cfg: OpenClawConfig;
  mode: "local" | "remote";
  env?: NodeJS.ProcessEnv;
  explicitAuth?: ExplicitGatewayAuth;
}): Promise<{ token?: string; password?: string }> {
  const policy = buildGatewayProbeCredentialPolicy(params);
  return await resolveGatewayCredentialsWithSecretInputs({
    config: policy.config,
    env: policy.env,
    explicitAuth: policy.explicitAuth,
    modeOverride: policy.modeOverride,
    remoteTokenFallback: policy.remoteTokenFallback,
  });
}

export async function resolveGatewayProbeAuthSafeWithSecretInputs(params: {
  cfg: OpenClawConfig;
  mode: "local" | "remote";
  env?: NodeJS.ProcessEnv;
  explicitAuth?: ExplicitGatewayAuth;
}): Promise<{
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
    const auth = await resolveGatewayProbeAuthWithSecretInputs(params);
    return { auth };
  } catch (error) {
    return {
      auth: {},
      warning: resolveGatewayProbeWarning(error),
    };
  }
}

export function resolveGatewayProbeAuthSafe(params: {
  cfg: OpenClawConfig;
  mode: "local" | "remote";
  env?: NodeJS.ProcessEnv;
  explicitAuth?: ExplicitGatewayAuth;
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
