import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveGatewayAuthToken } from "../../gateway/auth-token-resolution.js";
import { createGatewayCredentialPlan } from "../../gateway/credential-planner.js";
import { GatewaySecretRefUnavailableError } from "../../gateway/credentials.js";

function authModeDisablesToken(mode: string | undefined): boolean {
  return mode === "password" || mode === "none" || mode === "trusted-proxy";
}

function isPasswordFallbackActive(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): boolean {
  const plan = createGatewayCredentialPlan({
    config: params.cfg,
    env: params.env,
  });
  if (plan.authMode !== undefined) {
    return false;
  }
  return plan.passwordCanWin && !plan.tokenCanWin;
}

export async function resolveGatewayTokenForDriftCheck(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const env = params.env ?? process.env;
  const mode = params.cfg.gateway?.auth?.mode;
  if (authModeDisablesToken(mode)) {
    return undefined;
  }
  if (isPasswordFallbackActive({ cfg: params.cfg, env })) {
    return undefined;
  }

  const resolved = await resolveGatewayAuthToken({
    cfg: params.cfg,
    env,
    envFallback: "never",
    unresolvedReasonStyle: "detailed",
  });
  if (resolved.token) {
    return resolved.token;
  }
  if (!resolved.secretRefConfigured) {
    return undefined;
  }
  throw new GatewaySecretRefUnavailableError("gateway.auth.token");
}
