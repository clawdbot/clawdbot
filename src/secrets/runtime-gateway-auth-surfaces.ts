import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createGatewayCredentialPlan } from "../gateway/credential-planner.js";
import type { SecretDefaults } from "./runtime-shared.js";
import { isRecord } from "./shared.js";

export const GATEWAY_AUTH_SURFACE_PATHS = [
  "gateway.auth.token",
  "gateway.auth.password",
  "gateway.remote.token",
  "gateway.remote.password",
] as const;

export type GatewayAuthSurfacePath = (typeof GATEWAY_AUTH_SURFACE_PATHS)[number];

export type GatewayAuthSurfaceState = {
  path: GatewayAuthSurfacePath;
  active: boolean;
  reason: string;
  hasSecretRef: boolean;
};

export type GatewayAuthSurfaceStateMap = Record<GatewayAuthSurfacePath, GatewayAuthSurfaceState>;

function formatAuthMode(mode: string | undefined): string {
  return mode ?? "unset";
}

function describeRemoteConfiguredSurface(parts: {
  remoteMode: boolean;
  remoteUrlConfigured: boolean;
  tailscaleRemoteExposure: boolean;
}): string {
  const reasons: string[] = [];
  if (parts.remoteMode) {
    reasons.push('gateway.mode is "remote"');
  }
  if (parts.remoteUrlConfigured) {
    reasons.push("gateway.remote.url is configured");
  }
  if (parts.tailscaleRemoteExposure) {
    reasons.push('gateway.tailscale.mode is "serve" or "funnel"');
  }
  return reasons.join("; ");
}

function createState(params: {
  path: GatewayAuthSurfacePath;
  active: boolean;
  reason: string;
  hasSecretRef: boolean;
}): GatewayAuthSurfaceState {
  return {
    path: params.path,
    active: params.active,
    reason: params.reason,
    hasSecretRef: params.hasSecretRef,
  };
}

export function evaluateGatewayAuthSurfaceStates(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  defaults?: SecretDefaults;
}): GatewayAuthSurfaceStateMap {
  const gateway = params.config.gateway as Record<string, unknown> | undefined;
  if (!isRecord(gateway)) {
    return {
      "gateway.auth.token": createState({
        path: "gateway.auth.token",
        active: false,
        reason: "gateway configuration is not set.",
        hasSecretRef: false,
      }),
      "gateway.auth.password": createState({
        path: "gateway.auth.password",
        active: false,
        reason: "gateway configuration is not set.",
        hasSecretRef: false,
      }),
      "gateway.remote.token": createState({
        path: "gateway.remote.token",
        active: false,
        reason: "gateway configuration is not set.",
        hasSecretRef: false,
      }),
      "gateway.remote.password": createState({
        path: "gateway.remote.password",
        active: false,
        reason: "gateway configuration is not set.",
        hasSecretRef: false,
      }),
    };
  }
  const auth = isRecord(gateway?.auth) ? gateway.auth : undefined;
  const remote = isRecord(gateway?.remote) ? gateway.remote : undefined;
  const plan = createGatewayCredentialPlan({
    config: params.config,
    env: params.env,
    defaults: params.defaults,
  });

  const authPasswordReason = (() => {
    if (!auth) {
      return "gateway.auth is not configured.";
    }
    if (plan.passwordCanWin) {
      return plan.authMode === "password"
        ? 'gateway.auth.mode is "password".'
        : "no token source can win, so password auth can win.";
    }
    if (
      plan.authMode === "token" ||
      plan.authMode === "none" ||
      plan.authMode === "trusted-proxy"
    ) {
      return `gateway.auth.mode is "${plan.authMode}".`;
    }
    if (plan.envToken) {
      return "gateway token env var is configured.";
    }
    if (plan.localToken.configured) {
      return "gateway.auth.token is configured.";
    }
    if (plan.remoteToken.configured) {
      return "gateway.remote.token is configured.";
    }
    return "token auth can win.";
  })();

  const authTokenReason = (() => {
    if (!auth) {
      return "gateway.auth is not configured.";
    }
    if (plan.authMode === "token") {
      return plan.envToken
        ? "gateway token env var is configured."
        : 'gateway.auth.mode is "token".';
    }
    if (
      plan.authMode === "password" ||
      plan.authMode === "none" ||
      plan.authMode === "trusted-proxy"
    ) {
      return `gateway.auth.mode is "${plan.authMode}".`;
    }
    if (plan.envToken) {
      return "gateway token env var is configured.";
    }
    if (plan.envPassword) {
      return "gateway password env var is configured.";
    }
    if (plan.localPassword.configured) {
      return "gateway.auth.password is configured.";
    }
    return "token auth can win (mode is unset and no password source is configured).";
  })();

  const remoteSurfaceReason = describeRemoteConfiguredSurface({
    remoteMode: plan.remoteMode,
    remoteUrlConfigured: plan.remoteUrlConfigured,
    tailscaleRemoteExposure: plan.tailscaleRemoteExposure,
  });

  const remoteTokenReason = (() => {
    if (!remote) {
      return "gateway.remote is not configured.";
    }
    if (plan.remoteConfiguredSurface) {
      return `remote surface is active: ${remoteSurfaceReason}.`;
    }
    if (plan.remoteTokenFallbackActive) {
      return "local token auth can win and no env/auth token is configured.";
    }
    if (!plan.localTokenCanWin) {
      return `token auth cannot win with gateway.auth.mode="${formatAuthMode(plan.authMode)}".`;
    }
    if (plan.envToken) {
      return "gateway token env var is configured.";
    }
    if (plan.localToken.configured) {
      return "gateway.auth.token is configured.";
    }
    return "remote token fallback is not active.";
  })();

  const remotePasswordReason = (() => {
    if (!remote) {
      return "gateway.remote is not configured.";
    }
    if (plan.remoteConfiguredSurface) {
      return `remote surface is active: ${remoteSurfaceReason}.`;
    }
    if (plan.remotePasswordFallbackActive) {
      return "password auth can win and no env/auth password is configured.";
    }
    if (!plan.passwordCanWin) {
      if (
        plan.authMode === "token" ||
        plan.authMode === "none" ||
        plan.authMode === "trusted-proxy"
      ) {
        return `password auth cannot win with gateway.auth.mode="${plan.authMode}".`;
      }
      return "a token source can win, so password auth cannot win.";
    }
    if (plan.envPassword) {
      return "gateway password env var is configured.";
    }
    if (plan.localPassword.configured) {
      return "gateway.auth.password is configured.";
    }
    return "remote password fallback is not active.";
  })();

  return {
    "gateway.auth.token": createState({
      path: "gateway.auth.token",
      active: plan.localTokenSurfaceActive,
      reason: authTokenReason,
      hasSecretRef: plan.localToken.hasSecretRef,
    }),
    "gateway.auth.password": createState({
      path: "gateway.auth.password",
      active: plan.passwordCanWin,
      reason: authPasswordReason,
      hasSecretRef: plan.localPassword.hasSecretRef,
    }),
    "gateway.remote.token": createState({
      path: "gateway.remote.token",
      active: plan.remoteTokenActive,
      reason: remoteTokenReason,
      hasSecretRef: plan.remoteToken.hasSecretRef,
    }),
    "gateway.remote.password": createState({
      path: "gateway.remote.password",
      active: plan.remotePasswordActive,
      reason: remotePasswordReason,
      hasSecretRef: plan.remotePassword.hasSecretRef,
    }),
  };
}
