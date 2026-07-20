/**
 * Gateway config mutation for local non-interactive onboarding.
 *
 * This module owns port/bind/auth validation and existing-setting preservation
 * before the final config write happens.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { formatCliCommand } from "../../../cli/command-format.js";
import { formatInvalidPortOption } from "../../../cli/error-format.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { isValidEnvSecretRefId, resolveSecretInputRef } from "../../../config/types.secrets.js";
import type { RuntimeEnv } from "../../../runtime.js";
import { resolveDefaultSecretProviderAlias } from "../../../secrets/ref-contract.js";
import { normalizeGatewayTokenInput, randomToken } from "../../onboard-helpers.js";
import type { OnboardOptions } from "../../onboard-types.js";

/** Applies gateway CLI options to the pending config and returns normalized runtime settings. */
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

  const gatewayPort = opts.gatewayPort;
  if (
    gatewayPort !== undefined &&
    (!Number.isFinite(gatewayPort) || gatewayPort <= 0 || gatewayPort > 65_535)
  ) {
    runtime.error(formatInvalidPortOption("--gateway-port"));
    runtime.exit(1);
    return null;
  }

  const existingGateway = params.nextConfig.gateway;
  const port = gatewayPort ?? params.defaultPort;
  let bind = opts.gatewayBind ?? existingGateway?.bind ?? "loopback";
  const explicitAuthMode = opts.gatewayAuth;
  if (
    explicitAuthMode !== undefined &&
    explicitAuthMode !== "token" &&
    explicitAuthMode !== "password"
  ) {
    runtime.error('Invalid --gateway-auth. Use "token" or "password".');
    runtime.exit(1);
    return null;
  }
  const hasExplicitTokenAuthInput =
    opts.gatewayToken !== undefined || opts.gatewayTokenRefEnv !== undefined;
  let authMode =
    explicitAuthMode ??
    (hasExplicitTokenAuthInput ? "token" : existingGateway?.auth?.mode) ??
    "token";
  const tailscaleMode = opts.tailscale ?? existingGateway?.tailscale?.mode ?? "off";
  const tailscaleResetOnExit =
    opts.tailscaleResetOnExit ?? existingGateway?.tailscale?.resetOnExit ?? false;

  // Tighten config to safe combos:
  // - If Tailscale is on, force loopback bind (the tunnel handles external access).
  // - If using Tailscale Funnel, require password auth.
  // Preserve an existing combination on unrelated reruns; only normalize when
  // the operator is changing one of the fields that participates in the rule.
  const changesBindOrTailscale = opts.gatewayBind !== undefined || opts.tailscale !== undefined;
  if (changesBindOrTailscale && tailscaleMode !== "off" && bind !== "loopback") {
    bind = "loopback";
  }
  const changesAuthOrTailscale =
    explicitAuthMode !== undefined || hasExplicitTokenAuthInput || opts.tailscale !== undefined;
  if (changesAuthOrTailscale && tailscaleMode === "serve" && authMode === "none") {
    authMode = "token";
  }
  if (changesAuthOrTailscale && tailscaleMode === "funnel" && authMode !== "password") {
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
      // Env refs must be validated before writing config because the daemon
      // install plan will later depend on this exact env-var id.
      if (!isValidEnvSecretRefId(gatewayTokenRefEnv)) {
        runtime.error(
          "Invalid --gateway-token-ref-env. Use an environment variable name like OPENCLAW_GATEWAY_TOKEN.",
        );
        runtime.exit(1);
        return null;
      }
      if (explicitGatewayToken) {
        // Avoid ambiguous persistence: a plaintext token and a ref target cannot
        // both represent the same gateway auth field.
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
    const input = opts.gatewayPassword;
    const password =
      input === undefined
        ? (nextConfig.gateway?.auth?.password ??
          normalizeOptionalString(process.env.OPENCLAW_GATEWAY_PASSWORD))
        : normalizeOptionalString(input);
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
          ...(input !== undefined ? { password } : {}),
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
