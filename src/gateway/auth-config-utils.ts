import type { GatewayAuthConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasConfiguredSecretInput } from "../config/types.secrets.js";
import { resolveRequiredConfiguredSecretRefInputString } from "./resolve-configured-secret-input-string.js";
import {
  assignResolvedGatewaySecretInput,
  readGatewaySecretInputValue,
  type SupportedGatewaySecretInputPath,
} from "./secret-input-paths.js";

type GatewayAuthSecretInputPath = Extract<
  SupportedGatewaySecretInputPath,
  "gateway.auth.token" | "gateway.auth.password"
>;

type GatewayAuthSecretRefResolutionParams = {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  mode?: GatewayAuthConfig["mode"];
  hasPasswordCandidate: boolean;
  hasTokenCandidate: boolean;
};

/** Check whether a local Gateway auth input is configured directly or through defaults. */
export function hasConfiguredGatewayAuthSecretInput(
  cfg: OpenClawConfig,
  path: GatewayAuthSecretInputPath,
): boolean {
  return hasConfiguredSecretInput(readGatewaySecretInputValue(cfg, path), cfg.secrets?.defaults);
}

/** Decide whether a token/password secret ref can be active for the configured auth mode. */
function shouldResolveGatewayAuthSecretRef(params: {
  mode?: GatewayAuthConfig["mode"];
  path: GatewayAuthSecretInputPath;
  hasPasswordCandidate: boolean;
  hasTokenCandidate: boolean;
}): boolean {
  const isTokenPath = params.path === "gateway.auth.token";
  const hasPathCandidate = isTokenPath ? params.hasTokenCandidate : params.hasPasswordCandidate;
  if (hasPathCandidate) {
    return false;
  }
  if (params.mode === (isTokenPath ? "token" : "password")) {
    return true;
  }
  if (params.mode === "token" || params.mode === "none" || params.mode === "trusted-proxy") {
    return false;
  }
  if (params.mode === "password") {
    return !isTokenPath;
  }
  // With implicit mode, resolve the side that does not already have a concrete
  // candidate so token and password defaults do not both get materialized.
  return isTokenPath ? !params.hasPasswordCandidate : !params.hasTokenCandidate;
}

function shouldResolveGatewayTokenSecretRef(
  params: Omit<GatewayAuthSecretRefResolutionParams, "cfg" | "env">,
): boolean {
  return shouldResolveGatewayAuthSecretRef({
    mode: params.mode,
    path: "gateway.auth.token",
    hasPasswordCandidate: params.hasPasswordCandidate,
    hasTokenCandidate: params.hasTokenCandidate,
  });
}

function shouldResolveGatewayPasswordSecretRef(
  params: Omit<GatewayAuthSecretRefResolutionParams, "cfg" | "env">,
): boolean {
  return shouldResolveGatewayAuthSecretRef({
    mode: params.mode,
    path: "gateway.auth.password",
    hasPasswordCandidate: params.hasPasswordCandidate,
    hasTokenCandidate: params.hasTokenCandidate,
  });
}

async function resolveGatewayAuthSecretRefValue(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  path: GatewayAuthSecretInputPath;
  shouldResolve: boolean;
}): Promise<string | undefined> {
  if (!params.shouldResolve) {
    return undefined;
  }
  const value = await resolveRequiredConfiguredSecretRefInputString({
    config: params.cfg,
    env: params.env,
    value: readGatewaySecretInputValue(params.cfg, params.path),
    path: params.path,
  });
  if (!value) {
    return undefined;
  }
  return value;
}

/** Resolve the Gateway auth token ref only when token auth can use it. */
export async function resolveGatewayTokenSecretRefValue(
  params: GatewayAuthSecretRefResolutionParams,
): Promise<string | undefined> {
  return resolveGatewayAuthSecretRefValue({
    cfg: params.cfg,
    env: params.env,
    path: "gateway.auth.token",
    shouldResolve: shouldResolveGatewayTokenSecretRef(params),
  });
}

/** Resolve the Gateway auth password ref only when password auth can use it. */
export async function resolveGatewayPasswordSecretRefValue(
  params: GatewayAuthSecretRefResolutionParams,
): Promise<string | undefined> {
  return resolveGatewayAuthSecretRefValue({
    cfg: params.cfg,
    env: params.env,
    path: "gateway.auth.password",
    shouldResolve: shouldResolveGatewayPasswordSecretRef(params),
  });
}

async function resolveGatewayAuthSecretRef(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  path: GatewayAuthSecretInputPath;
  shouldResolve: boolean;
}): Promise<OpenClawConfig> {
  const value = await resolveGatewayAuthSecretRefValue(params);
  if (!value) {
    return params.cfg;
  }
  const nextConfig = structuredClone(params.cfg);
  nextConfig.gateway ??= {};
  nextConfig.gateway.auth ??= {};
  assignResolvedGatewaySecretInput({
    config: nextConfig,
    path: params.path,
    value,
  });
  return nextConfig;
}

async function resolveGatewayPasswordSecretRef(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  mode?: GatewayAuthConfig["mode"];
  hasPasswordCandidate: boolean;
  hasTokenCandidate: boolean;
}): Promise<OpenClawConfig> {
  return resolveGatewayAuthSecretRef({
    cfg: params.cfg,
    env: params.env,
    path: "gateway.auth.password",
    shouldResolve: shouldResolveGatewayPasswordSecretRef(params),
  });
}

/** Materialize active local Gateway auth secret refs on a cloned config. */
export async function materializeGatewayAuthSecretRefs(
  params: GatewayAuthSecretRefResolutionParams,
): Promise<OpenClawConfig> {
  const cfgWithToken = await resolveGatewayAuthSecretRef({
    cfg: params.cfg,
    env: params.env,
    path: "gateway.auth.token",
    shouldResolve: shouldResolveGatewayTokenSecretRef(params),
  });
  return await resolveGatewayPasswordSecretRef({
    cfg: cfgWithToken,
    env: params.env,
    mode: params.mode,
    hasPasswordCandidate: params.hasPasswordCandidate,
    hasTokenCandidate:
      params.hasTokenCandidate ||
      hasConfiguredGatewayAuthSecretInput(cfgWithToken, "gateway.auth.token"),
  });
}
