// Gateway startup runtime-config resolver.
// Normalizes bind/auth/HTTP/Tailscale/hook settings before server construction.
import type {
  GatewayAuthConfig,
  GatewayBindMode,
  GatewayTailscaleConfig,
} from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  formatUnsafeGatewayTailscaleNoAuthMessage,
  isUnsafeGatewayTailscaleNoAuth,
} from "../shared/gateway-tailscale-auth-policy.js";
import {
  assertGatewayAuthConfigured,
  type ResolvedGatewayAuth,
  resolveGatewayAuth,
} from "./auth.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";
import { warnLegacyOpenClawEnvVars } from "./env-deprecation.js";
import { commitHooksConfigReload, resolveHooksConfig } from "./hooks.js";
import {
  defaultGatewayBindMode,
  isLoopbackHost,
  isValidIPv4,
  resolveGatewayBindHost,
} from "./net.js";
import { mergeGatewayTailscaleConfig } from "./startup-auth.js";

type GatewayRuntimeConfig = {
  bindHost: string;
  controlUiEnabled: boolean;
  openAiChatCompletionsEnabled: boolean;
  openAiChatCompletionsConfig?: import("../config/types.gateway.js").GatewayHttpChatCompletionsConfig;
  openResponsesEnabled: boolean;
  openResponsesConfig?: import("../config/types.gateway.js").GatewayHttpResponsesConfig;
  strictTransportSecurityHeader?: string;
  controlUiBasePath: string;
  controlUiRoot?: string;
  resolvedAuth: ResolvedGatewayAuth;
  authMode: ResolvedGatewayAuth["mode"];
  tailscaleConfig: GatewayTailscaleConfig;
  tailscaleMode: "off" | "serve" | "funnel";
  hooksConfig: ReturnType<typeof resolveHooksConfig>;
};

type GatewayStartupRuntimePolicyIssue = {
  code:
    | "gateway-tailscale-funnel-password-required"
    | "gateway-tailscale-auth-unsafe"
    | "gateway-tailscale-loopback-required"
    | "gateway-bind-auth-required"
    | "gateway-control-ui-origins-required"
    | "gateway-trusted-proxies-required";
  message: string;
  remediation: readonly string[];
  configPath:
    | "gateway.auth"
    | "gateway.auth.mode"
    | "gateway.bind"
    | "gateway.controlUi.allowedOrigins"
    | "gateway.trustedProxies";
};

export type GatewayStartupRuntimePolicyInspection =
  | { status: "ready" }
  | { status: "blocked"; issue: GatewayStartupRuntimePolicyIssue }
  | { status: "indeterminate"; reason: string };

/**
 * Inspect the pure Gateway runtime policy enforced after bind and auth resolution.
 * An indeterminate host class keeps host-dependent policy passive.
 */
export function inspectGatewayStartupRuntimePolicy(params: {
  authMode: ResolvedGatewayAuth["mode"];
  hasSharedSecret: boolean;
  bindHost?: string;
  hostClass: "loopback" | "non-loopback" | "indeterminate";
  controlUiEnabled: boolean;
  controlUiAllowedOrigins: readonly string[];
  dangerouslyAllowHostHeaderOriginFallback: boolean;
  tailscaleMode: "off" | "serve" | "funnel";
  trustedProxies: readonly string[];
  port?: number;
}): GatewayStartupRuntimePolicyInspection {
  if (params.tailscaleMode === "funnel" && params.authMode !== "password") {
    return {
      status: "blocked",
      issue: {
        code: "gateway-tailscale-funnel-password-required",
        message:
          "tailscale funnel requires gateway auth mode=password (set gateway.auth.password or OPENCLAW_GATEWAY_PASSWORD)",
        remediation: [
          "Set gateway.auth.mode=password and provide gateway.auth.password or OPENCLAW_GATEWAY_PASSWORD.",
        ],
        configPath: "gateway.auth.mode",
      },
    };
  }
  if (
    isUnsafeGatewayTailscaleNoAuth({
      authMode: params.authMode,
      tailscaleMode: params.tailscaleMode,
    })
  ) {
    return {
      status: "blocked",
      issue: {
        code: "gateway-tailscale-auth-unsafe",
        message: formatUnsafeGatewayTailscaleNoAuthMessage(params.tailscaleMode),
        remediation: [
          "Configure token, password, or trusted-proxy auth before exposing the Gateway through Tailscale.",
        ],
        configPath: "gateway.auth",
      },
    };
  }
  if (params.hostClass === "indeterminate") {
    if (params.authMode === "trusted-proxy" && params.trustedProxies.length === 0) {
      return {
        status: "blocked",
        issue: {
          code: "gateway-trusted-proxies-required",
          message:
            "gateway auth mode=trusted-proxy requires gateway.trustedProxies to be configured with at least one proxy IP",
          remediation: ["Configure gateway.trustedProxies with at least one trusted proxy IP."],
          configPath: "gateway.trustedProxies",
        },
      };
    }
    return {
      status: "indeterminate",
      reason:
        "Gateway runtime policy depends on the effective bind host, which passive preflight did not resolve.",
    };
  }
  if (params.tailscaleMode !== "off" && params.hostClass !== "loopback") {
    return {
      status: "blocked",
      issue: {
        code: "gateway-tailscale-loopback-required",
        message: "tailscale serve/funnel requires gateway bind=loopback (127.0.0.1)",
        remediation: ["Set gateway.bind=loopback when gateway.tailscale.mode is enabled."],
        configPath: "gateway.bind",
      },
    };
  }
  if (
    params.hostClass === "non-loopback" &&
    !params.hasSharedSecret &&
    params.authMode !== "trusted-proxy"
  ) {
    const target = params.bindHost
      ? `${params.bindHost}${params.port ? `:${params.port}` : ""}`
      : "a non-loopback host";
    return {
      status: "blocked",
      issue: {
        code: "gateway-bind-auth-required",
        message: `refusing to bind gateway to ${target} without auth (set gateway.auth.token/password, or set OPENCLAW_GATEWAY_TOKEN/OPENCLAW_GATEWAY_PASSWORD; legacy CLAWDBOT_* and MOLTBOT_* environment variables are ignored)`,
        remediation: [
          "Set gateway.auth.token/password or the corresponding target environment variable.",
        ],
        configPath: "gateway.auth",
      },
    };
  }
  if (
    params.controlUiEnabled &&
    params.hostClass === "non-loopback" &&
    params.controlUiAllowedOrigins.length === 0 &&
    !params.dangerouslyAllowHostHeaderOriginFallback
  ) {
    return {
      status: "blocked",
      issue: {
        code: "gateway-control-ui-origins-required",
        message:
          "non-loopback Control UI requires gateway.controlUi.allowedOrigins (set explicit origins), or set gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true to use Host-header origin fallback mode",
        remediation: [
          "Set gateway.controlUi.allowedOrigins to the explicit browser origins for this Gateway.",
        ],
        configPath: "gateway.controlUi.allowedOrigins",
      },
    };
  }
  if (params.authMode === "trusted-proxy" && params.trustedProxies.length === 0) {
    return {
      status: "blocked",
      issue: {
        code: "gateway-trusted-proxies-required",
        message:
          "gateway auth mode=trusted-proxy requires gateway.trustedProxies to be configured with at least one proxy IP",
        remediation: ["Configure gateway.trustedProxies with at least one trusted proxy IP."],
        configPath: "gateway.trustedProxies",
      },
    };
  }
  return { status: "ready" };
}

/** Resolves bind, auth, HTTP, Tailscale, and hook settings for one gateway start. */
export async function resolveGatewayRuntimeConfig(params: {
  cfg: OpenClawConfig;
  port: number;
  bind?: GatewayBindMode;
  host?: string;
  controlUiEnabled?: boolean;
  openAiChatCompletionsEnabled?: boolean;
  openResponsesEnabled?: boolean;
  auth?: GatewayAuthConfig;
  tailscale?: GatewayTailscaleConfig;
}): Promise<GatewayRuntimeConfig> {
  warnLegacyOpenClawEnvVars();

  // Tailscale serve/funnel hard-requires loopback.  When bind is not
  // explicitly set, we must resolve Tailscale mode *before* choosing the
  // bind default so that container auto-detection does not override the
  // Tailscale loopback constraint.
  const tailscaleModeEarly =
    (params.tailscale?.mode ?? params.cfg.gateway?.tailscale?.mode) || "off";
  const bindExplicit = params.bind ?? params.cfg.gateway?.bind;
  const bindMode =
    bindExplicit ?? (tailscaleModeEarly !== "off" ? "loopback" : defaultGatewayBindMode());
  const customBindHost = params.cfg.gateway?.customBindHost;
  const bindHost = params.host ?? (await resolveGatewayBindHost(bindMode, customBindHost));
  if (bindMode === "loopback" && !isLoopbackHost(bindHost)) {
    throw new Error(
      `gateway bind=loopback resolved to non-loopback host ${bindHost}; refusing fallback to a network bind`,
    );
  }
  if (bindMode === "tailnet" && bindHost === "0.0.0.0") {
    throw new Error(
      "gateway bind=tailnet could not resolve a Tailscale or loopback address; refusing wildcard fallback",
    );
  }
  if (bindMode === "custom") {
    const configuredCustomBindHost = customBindHost?.trim();
    if (!configuredCustomBindHost) {
      throw new Error("gateway.bind=custom requires gateway.customBindHost");
    }
    if (!isValidIPv4(configuredCustomBindHost)) {
      throw new Error(
        `gateway.bind=custom requires a valid IPv4 customBindHost (got ${configuredCustomBindHost})`,
      );
    }
    if (bindHost !== configuredCustomBindHost) {
      throw new Error(
        `gateway bind=custom requested ${configuredCustomBindHost} but resolved ${bindHost}; refusing fallback`,
      );
    }
  }
  const controlUiEnabled =
    params.controlUiEnabled ?? params.cfg.gateway?.controlUi?.enabled ?? true;
  const openAiChatCompletionsConfig = params.cfg.gateway?.http?.endpoints?.chatCompletions;
  const openAiChatCompletionsEnabled =
    params.openAiChatCompletionsEnabled ?? openAiChatCompletionsConfig?.enabled ?? false;
  const openResponsesConfig = params.cfg.gateway?.http?.endpoints?.responses;
  const openResponsesEnabled = params.openResponsesEnabled ?? openResponsesConfig?.enabled ?? false;
  const strictTransportSecurityConfig =
    params.cfg.gateway?.http?.securityHeaders?.strictTransportSecurity;
  // HSTS is opt-in and must stay absent for blank strings; local HTTP and reverse-proxy
  // setups rely on not emitting a malformed or accidentally inherited header.
  const strictTransportSecurityHeader =
    strictTransportSecurityConfig === false
      ? undefined
      : typeof strictTransportSecurityConfig === "string" &&
          strictTransportSecurityConfig.trim().length > 0
        ? strictTransportSecurityConfig.trim()
        : undefined;
  const controlUiBasePath = normalizeControlUiBasePath(params.cfg.gateway?.controlUi?.basePath);
  const controlUiRootRaw = params.cfg.gateway?.controlUi?.root;
  const controlUiRoot =
    typeof controlUiRootRaw === "string" && controlUiRootRaw.trim().length > 0
      ? controlUiRootRaw.trim()
      : undefined;
  const tailscaleBase = params.cfg.gateway?.tailscale ?? {};
  const tailscaleOverrides = params.tailscale ?? {};
  const tailscaleConfig = mergeGatewayTailscaleConfig(tailscaleBase, tailscaleOverrides);
  const tailscaleMode = tailscaleConfig.mode ?? "off";
  const resolvedAuth = resolveGatewayAuth({
    authConfig: params.cfg.gateway?.auth,
    authOverride: params.auth,
    env: process.env,
    tailscaleMode,
  });
  const authMode: ResolvedGatewayAuth["mode"] = resolvedAuth.mode;
  const hasToken = typeof resolvedAuth.token === "string" && resolvedAuth.token.trim().length > 0;
  const hasPassword =
    typeof resolvedAuth.password === "string" && resolvedAuth.password.trim().length > 0;
  // Non-loopback binds need a concrete shared secret unless auth is delegated to a
  // trusted proxy; mode alone is not enough because env/config resolution may be empty.
  const hasSharedSecret =
    (authMode === "token" && hasToken) || (authMode === "password" && hasPassword);
  const hooksConfig = resolveHooksConfig(params.cfg);
  const trustedProxies = params.cfg.gateway?.trustedProxies ?? [];
  const controlUiAllowedOrigins = (params.cfg.gateway?.controlUi?.allowedOrigins ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
  const dangerouslyAllowHostHeaderOriginFallback =
    params.cfg.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true;

  assertGatewayAuthConfigured(resolvedAuth, params.cfg.gateway?.auth);
  const runtimePolicy = inspectGatewayStartupRuntimePolicy({
    authMode,
    hasSharedSecret,
    bindHost,
    hostClass: isLoopbackHost(bindHost) ? "loopback" : "non-loopback",
    controlUiEnabled,
    controlUiAllowedOrigins,
    dangerouslyAllowHostHeaderOriginFallback,
    tailscaleMode,
    trustedProxies,
    port: params.port,
  });
  if (runtimePolicy.status === "blocked") {
    throw new Error(runtimePolicy.issue.message);
  }

  if (hooksConfig) {
    commitHooksConfigReload();
  }

  return {
    bindHost,
    controlUiEnabled,
    openAiChatCompletionsEnabled,
    openAiChatCompletionsConfig: openAiChatCompletionsConfig
      ? { ...openAiChatCompletionsConfig, enabled: openAiChatCompletionsEnabled }
      : undefined,
    openResponsesEnabled,
    openResponsesConfig: openResponsesConfig
      ? { ...openResponsesConfig, enabled: openResponsesEnabled }
      : undefined,
    strictTransportSecurityHeader,
    controlUiBasePath,
    controlUiRoot,
    resolvedAuth,
    authMode,
    tailscaleConfig,
    tailscaleMode,
    hooksConfig,
  };
}
