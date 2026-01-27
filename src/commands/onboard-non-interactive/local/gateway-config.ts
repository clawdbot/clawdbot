import type { MoltbotConfig } from "../../../config/config.js";
import type { RuntimeEnv } from "../../../runtime.js";
import { randomToken } from "../../onboard-helpers.js";
import type { OnboardOptions } from "../../onboard-types.js";

export function applyNonInteractiveGatewayConfig(params: {
  nextConfig: MoltbotConfig;
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  defaultPort: number;
}): {
  nextConfig: MoltbotConfig;
  port: number;
  bind: string;
  authMode: string;
  tailscaleMode: string;
  tailscaleResetOnExit: boolean;
  gatewayToken?: string;
} | null {
  const { opts, runtime } = params;

  const hasGatewayPort = opts.gatewayPort !== undefined;
  if (hasGatewayPort && (!Number.isFinite(opts.gatewayPort) || (opts.gatewayPort ?? 0) <= 0)) {
    runtime.error("Invalid --gateway-port");
    runtime.exit(1);
    return null;
  }

  const port = hasGatewayPort ? (opts.gatewayPort as number) : params.defaultPort;
  let bind = opts.gatewayBind ?? "loopback";
  const authModeRaw = opts.gatewayAuth ?? "token";
  if (authModeRaw !== "token" && authModeRaw !== "password") {
    runtime.error("Invalid --gateway-auth (use token|password).");
    runtime.exit(1);
    return null;
  }
  let authMode = authModeRaw;
  const tailscaleMode = opts.tailscale ?? "off";
  const tailscaleResetOnExit = Boolean(opts.tailscaleResetOnExit);

  // Tighten config to safe combos:
  // - If Tailscale is on, force loopback bind (the tunnel handles external access).
  // - If using Tailscale Funnel, require password auth.
  if (tailscaleMode !== "off" && bind !== "loopback") bind = "loopback";
  if (tailscaleMode === "funnel" && authMode !== "password") authMode = "password";

  let nextConfig = params.nextConfig;
  let gatewayToken = opts.gatewayToken?.trim() || undefined;

  if (authMode === "token") {
    if (!gatewayToken) gatewayToken = randomToken();
    nextConfig = {
      ...nextConfig,
      gateway: {
        ...nextConfig.gateway,
        auth: {
          ...nextConfig.gateway?.auth,
          mode: "token",
          token: gatewayToken,
        },
      },
    };
  }

  if (authMode === "password") {
    const password = opts.gatewayPassword?.trim();
    if (!password) {
      runtime.error("Missing --gateway-password for password auth.");
      runtime.exit(1);
      return null;
    }
    nextConfig = {
      ...nextConfig,
      gateway: {
        ...nextConfig.gateway,
        auth: {
          ...nextConfig.gateway?.auth,
          mode: "password",
          password,
        },
      },
    };
  }

  nextConfig = {
    ...nextConfig,
    gateway: {
      ...nextConfig.gateway,
      port,
      bind,
      tailscale: {
        ...nextConfig.gateway?.tailscale,
        mode: tailscaleMode,
        resetOnExit: tailscaleResetOnExit,
      },
    },
  };

  return {
    nextConfig,
    port,
    bind,
    authMode,
    tailscaleMode,
    tailscaleResetOnExit,
    gatewayToken,
  };
}
