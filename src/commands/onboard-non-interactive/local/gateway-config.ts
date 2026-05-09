import { formatCliCommand } from "../../../cli/command-format.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { isValidEnvSecretRefId, resolveSecretInputRef } from "../../../config/types.secrets.js";
import type { RuntimeEnv } from "../../../runtime.js";
import { resolveDefaultSecretProviderAlias } from "../../../secrets/ref-contract.js";
import { normalizeOptionalString } from "../../../shared/string-coerce.js";
import { normalizeGatewayTokenInput, randomToken } from "../../onboard-helpers.js";
import type { OnboardOptions } from "../../onboard-types.js";

export function applyNonInteractiveGatewayConfig(params: {
  nextConfig: OpenClawConfig;
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  defaultPort: number;
}): {
  nextConfig: OpenClawConfig;
  port: number;
  bind: string;
  authMode: string;
  tailscaleMode: string;
  tailscaleResetOnExit: boolean;
} | null {
  const { opts, runtime } = params;

  const hasGatewayPort = opts.gatewayPort !== undefined;
  if (hasGatewayPort && (!Number.isFinite(opts.gatewayPort) || (opts.gatewayPort ?? 0) <= 0)) {
    runtime.error("Invalid --gateway-port. Use a positive port number, for example 3000.");
    runtime.exit(1);
    return null;
  }

  const port = hasGatewayPort ? (opts.gatewayPort as number) : params.defaultPort;
  let bind = opts.gatewayBind ?? "loopback";
  const authModeRaw = opts.gatewayAuth ?? "token";
  if (authModeRaw !== "token" && authModeRaw !== "password") {
    runtime.error('Invalid --gateway-auth. Use "token" or "password".');
    runtime.exit(1);
    return null;
  }
  let authMode = authModeRaw;
  const tailscaleMode = opts.tailscale ?? "off";
  const tailscaleResetOnExit = Boolean(opts.tailscaleResetOnExit);

  // Tighten config to safe combos:
  // - If Tailscale is on, force loopback bind (the tunnel handles external access).
  // - If using Tailscale Funnel, require password auth.
  if (tailscaleMode !== "off" && bind !== "loopback") {
    bind = "loopback";
  }
  if (tailscaleMode === "funnel" && authMode !== "password") {
    authMode = "password";
  }

  let nextConfig = params.nextConfig;
  const explicitGatewayToken = normalizeGatewayTokenInput(opts.gatewayToken);
  const envGatewayToken = normalizeGatewayTokenInput(process.env.OPENCLAW_GATEWAY_TOKEN);
  const existingTokenInput = nextConfig.gateway?.auth?.token;
  const existingTokenRef = resolveSecretInputRef({
    value: existingTokenInput,
    defaults: nextConfig.secrets?.defaults,
  }).ref;
  const existingPlaintextToken = normalizeGatewayTokenInput(existingTokenInput);
  // Resolution order on re-onboard: explicit --gateway-token > persisted
  // plaintext > ambient OPENCLAW_GATEWAY_TOKEN > randomToken(). Ambient env
  // must not rotate a token already written to disk — a stale shell or
  // launchd env var otherwise breaks already-paired clients.
  let gatewayToken = explicitGatewayToken || existingPlaintextToken || envGatewayToken || undefined;
  const gatewayTokenRefEnv = normalizeOptionalString(opts.gatewayTokenRefEnv ?? "") ?? "";

  if (authMode === "token") {
    if (gatewayTokenRefEnv) {
      if (!isValidEnvSecretRefId(gatewayTokenRefEnv)) {
        runtime.error(
          "Invalid --gateway-token-ref-env. Use an environment variable name like OPENCLAW_GATEWAY_TOKEN.",
        );
        runtime.exit(1);
        return null;
      }
      if (explicitGatewayToken) {
        runtime.error(
          "Use either --gateway-token or --gateway-token-ref-env, not both. Prefer --gateway-token-ref-env to avoid writing plaintext tokens.",
        );
        runtime.exit(1);
        return null;
      }
      const resolvedFromEnv = process.env[gatewayTokenRefEnv]?.trim();
      if (!resolvedFromEnv) {
        runtime.error(
          `Environment variable "${gatewayTokenRefEnv}" is missing or empty. Export it first, then rerun ${formatCliCommand("openclaw onboard --non-interactive")}.`,
        );
        runtime.exit(1);
        return null;
      }
      gatewayToken = resolvedFromEnv;
      nextConfig = {
        ...nextConfig,
        gateway: {
          ...nextConfig.gateway,
          auth: {
            ...nextConfig.gateway?.auth,
            mode: "token",
            token: {
              source: "env",
              provider: resolveDefaultSecretProviderAlias(nextConfig, "env", {
                preferFirstProviderForSource: true,
              }),
              id: gatewayTokenRefEnv,
            },
          },
        },
      };
    } else if (!explicitGatewayToken && existingTokenRef) {
      // Preserve an already-configured SecretRef on re-onboard. Without this
      // branch, an ambient OPENCLAW_GATEWAY_TOKEN (or randomToken() fallback)
      // would silently overwrite {source, provider, id} with a plaintext
      // literal, de-secretref-ing the gateway.
      nextConfig = {
        ...nextConfig,
        gateway: {
          ...nextConfig.gateway,
          auth: {
            ...nextConfig.gateway?.auth,
            mode: "token",
            // token field intentionally preserved as the existing SecretRef.
          },
        },
      };
    } else {
      if (!gatewayToken) {
        gatewayToken = randomToken();
      }
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
  }

  if (authMode === "password") {
    const password = opts.gatewayPassword?.trim();
    if (!password) {
      runtime.error(
        "Missing --gateway-password for password auth. Pass --gateway-password or use --gateway-auth token.",
      );
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
  };
}
