import { isIP } from "node:net";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasConfiguredSecretInput } from "../config/types.secrets.js";
import { resolveGatewayAuth } from "../gateway/auth-resolve.js";
import { resolveGatewayAuthTokenSourceConflict } from "../gateway/auth-token-source-conflict.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../shared/string-coerce.js";
import type { SecurityAuditFinding } from "./audit.types.js";
import { collectCoreInsecureOrDangerousFlags } from "./core-dangerous-config-flags.js";
import { DEFAULT_GATEWAY_HTTP_TOOL_DENY } from "./dangerous-tools.js";

type CollectDangerousConfigFlags = (cfg: OpenClawConfig) => string[];

export type CollectGatewayConfigFindingsOptions = {
  collectDangerousConfigFlags?: CollectDangerousConfigFlags;
};

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function collectGatewayConfigFindings(
  cfg: OpenClawConfig,
  sourceConfig: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  options: CollectGatewayConfigFindingsOptions = {},
): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];

  const bind = typeof cfg.gateway?.bind === "string" ? cfg.gateway.bind : "loopback";
  const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
  const auth = resolveGatewayAuth({ authConfig: cfg.gateway?.auth, tailscaleMode, env });
  const controlUiEnabled = cfg.gateway?.controlUi?.enabled !== false;
  const controlUiAllowedOrigins = (cfg.gateway?.controlUi?.allowedOrigins ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
  const dangerouslyAllowHostHeaderOriginFallback =
    cfg.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true;
  const trustedProxies = Array.isArray(cfg.gateway?.trustedProxies)
    ? cfg.gateway.trustedProxies
    : [];
  const hasToken = typeof auth.token === "string" && auth.token.trim().length > 0;
  const hasPassword = typeof auth.password === "string" && auth.password.trim().length > 0;
  const envTokenConfigured = hasNonEmptyString(env.OPENCLAW_GATEWAY_TOKEN);
  const envPasswordConfigured = hasNonEmptyString(env.OPENCLAW_GATEWAY_PASSWORD);
  const tokenConfiguredFromConfig = hasConfiguredSecretInput(
    sourceConfig.gateway?.auth?.token,
    sourceConfig.secrets?.defaults,
  );
  const passwordConfiguredFromConfig = hasConfiguredSecretInput(
    sourceConfig.gateway?.auth?.password,
    sourceConfig.secrets?.defaults,
  );
  const remoteTokenConfigured = hasConfiguredSecretInput(
    sourceConfig.gateway?.remote?.token,
    sourceConfig.secrets?.defaults,
  );
  const explicitAuthMode = sourceConfig.gateway?.auth?.mode;
  const tokenCanWin =
    hasToken || envTokenConfigured || tokenConfiguredFromConfig || remoteTokenConfigured;
  const passwordCanWin =
    explicitAuthMode === "password" ||
    (explicitAuthMode !== "token" &&
      explicitAuthMode !== "none" &&
      explicitAuthMode !== "trusted-proxy" &&
      !tokenCanWin);
  const tokenConfigured = tokenCanWin;
  const passwordConfigured =
    hasPassword || (passwordCanWin && (envPasswordConfigured || passwordConfiguredFromConfig));
  const hasSharedSecret =
    explicitAuthMode === "token"
      ? tokenConfigured
      : explicitAuthMode === "password"
        ? passwordConfigured
        : explicitAuthMode === "none" || explicitAuthMode === "trusted-proxy"
          ? false
          : tokenConfigured || passwordConfigured;
  const hasTailscaleAuth = auth.allowTailscale && tailscaleMode === "serve";
  const hasGatewayAuth = hasSharedSecret || hasTailscaleAuth;
  const allowRealIpFallback = cfg.gateway?.allowRealIpFallback === true;
  const mdnsMode = cfg.discovery?.mdns?.mode ?? "minimal";

  // HTTP /tools/invoke is intended for narrow automation, not session orchestration/admin operations.
  // If operators opt-in to re-enabling these tools over HTTP, warn loudly so the choice is explicit.
  const gatewayToolsAllowRaw = Array.isArray(cfg.gateway?.tools?.allow)
    ? cfg.gateway?.tools?.allow
    : [];
  const gatewayToolsAllow = new Set(
    gatewayToolsAllowRaw.map((v) => normalizeOptionalLowercaseString(v) ?? "").filter(Boolean),
  );
  const reenabledOverHttp = DEFAULT_GATEWAY_HTTP_TOOL_DENY.filter((name) =>
    gatewayToolsAllow.has(name),
  );
  if (reenabledOverHttp.length > 0) {
    const extraRisk = bind !== "loopback" || tailscaleMode === "funnel";
    findings.push({
      checkId: "gateway.tools_invoke_http.dangerous_allow",
      severity: extraRisk ? "critical" : "warn",
      title: "Gateway HTTP /tools/invoke re-enables dangerous tools",
      detail:
        `gateway.tools.allow includes ${reenabledOverHttp.join(", ")} which removes them from the default HTTP deny list. ` +
        "This can allow remote session spawning / control-plane actions via HTTP and increases RCE blast radius if the gateway is reachable.",
      remediation:
        "Remove these entries from gateway.tools.allow (recommended). " +
        "If you keep them enabled, keep gateway.bind loopback-only (or tailnet-only), restrict network exposure, and treat the gateway token/password as full-admin.",
    });
  }
  if (bind !== "loopback" && !hasSharedSecret && auth.mode !== "trusted-proxy") {
    findings.push({
      checkId: "gateway.bind_no_auth",
      severity: "critical",
      title: "Gateway binds beyond loopback without auth",
      detail: `gateway.bind="${bind}" but no gateway.auth token/password is configured.`,
      remediation: `Set gateway.auth (token recommended) or bind to loopback.`,
    });
  }

  const tokenConflict = resolveGatewayAuthTokenSourceConflict({ cfg: sourceConfig, env });
  if (tokenConflict) {
    findings.push({
      checkId: tokenConflict.checkId,
      severity: "warn",
      title: tokenConflict.title,
      detail: tokenConflict.detail,
      remediation: tokenConflict.remediation,
    });
  }

  if (bind === "loopback" && controlUiEnabled && trustedProxies.length === 0) {
    findings.push({
      checkId: "gateway.trusted_proxies_missing",
      severity: "warn",
      title: "Reverse proxy headers are not trusted",
      detail:
        "gateway.bind is loopback and gateway.trustedProxies is empty. " +
        "If you expose the Control UI through a reverse proxy, configure trusted proxies " +
        "so local-client checks cannot be spoofed.",
      remediation:
        "Set gateway.trustedProxies to your proxy IPs or keep the Control UI local-only.",
    });
  }

  if (bind === "loopback" && controlUiEnabled && !hasGatewayAuth) {
    findings.push({
      checkId: "gateway.loopback_no_auth",
      severity: "critical",
      title: "Gateway auth missing on loopback",
      detail:
        "gateway.bind is loopback but no gateway auth secret is configured. " +
        "If the Control UI is exposed through a reverse proxy, unauthenticated access is possible.",
      remediation: "Set gateway.auth (token recommended) or keep the Control UI local-only.",
    });
  }
  if (
    bind !== "loopback" &&
    controlUiEnabled &&
    controlUiAllowedOrigins.length === 0 &&
    !dangerouslyAllowHostHeaderOriginFallback
  ) {
    findings.push({
      checkId: "gateway.control_ui.allowed_origins_required",
      severity: "critical",
      title: "Non-loopback Control UI missing explicit allowed origins",
      detail:
        "Control UI is enabled on a non-loopback bind but gateway.controlUi.allowedOrigins is empty. " +
        "Strict origin policy requires explicit allowed origins for non-loopback deployments.",
      remediation:
        "Set gateway.controlUi.allowedOrigins to full trusted origins (for example https://control.example.com). " +
        "If your deployment intentionally relies on Host-header origin fallback, set gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true.",
    });
  }
  if (controlUiAllowedOrigins.includes("*")) {
    const exposed = bind !== "loopback";
    findings.push({
      checkId: "gateway.control_ui.allowed_origins_wildcard",
      severity: exposed ? "critical" : "warn",
      title: "Control UI allowed origins contains wildcard",
      detail:
        'gateway.controlUi.allowedOrigins includes "*" which means allow any browser origin for Control UI/WebChat requests. This disables origin allowlisting and should be treated as an intentional allow-all policy.',
      remediation:
        'Replace wildcard origins with explicit trusted origins (for example https://control.example.com). Do not use "*" outside tightly controlled local testing.',
    });
  }
  if (dangerouslyAllowHostHeaderOriginFallback) {
    const exposed = bind !== "loopback";
    findings.push({
      checkId: "gateway.control_ui.host_header_origin_fallback",
      severity: exposed ? "critical" : "warn",
      title: "DANGEROUS: Host-header origin fallback enabled",
      detail:
        "gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true enables Host-header origin fallback " +
        "for Control UI/WebChat websocket checks and weakens DNS rebinding protections.",
      remediation:
        "Disable gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback and configure explicit gateway.controlUi.allowedOrigins.",
    });
  }

  if (allowRealIpFallback) {
    const hasNonLoopbackTrustedProxy = trustedProxies.some(
      (proxy) => !isStrictLoopbackTrustedProxyEntry(proxy),
    );
    const exposed =
      bind !== "loopback" || (auth.mode === "trusted-proxy" && hasNonLoopbackTrustedProxy);
    findings.push({
      checkId: "gateway.real_ip_fallback_enabled",
      severity: exposed ? "critical" : "warn",
      title: "X-Real-IP fallback is enabled",
      detail:
        "gateway.allowRealIpFallback=true trusts X-Real-IP when trusted proxies omit X-Forwarded-For. " +
        "Misconfigured proxies that forward client-supplied X-Real-IP can spoof source IP and local-client checks.",
      remediation:
        "Keep gateway.allowRealIpFallback=false (default). Only enable this when your trusted proxy " +
        "always overwrites X-Real-IP and cannot provide X-Forwarded-For.",
    });
  }

  if (mdnsMode === "full") {
    const exposed = bind !== "loopback";
    findings.push({
      checkId: "discovery.mdns_full_mode",
      severity: exposed ? "critical" : "warn",
      title: "mDNS full mode can leak host metadata",
      detail:
        'discovery.mdns.mode="full" publishes cliPath/sshPort in local-network TXT records. ' +
        "This can reveal usernames, filesystem layout, and management ports.",
      remediation:
        'Prefer discovery.mdns.mode="minimal" (recommended) or "off", especially when gateway.bind is not loopback.',
    });
  }

  if (tailscaleMode === "funnel") {
    findings.push({
      checkId: "gateway.tailscale_funnel",
      severity: "critical",
      title: "Tailscale Funnel exposure enabled",
      detail: `gateway.tailscale.mode="funnel" exposes the Gateway publicly; keep auth strict and treat it as internet-facing.`,
      remediation: `Prefer tailscale.mode="serve" (tailnet-only) or set tailscale.mode="off".`,
    });
  } else if (tailscaleMode === "serve") {
    findings.push({
      checkId: "gateway.tailscale_serve",
      severity: "info",
      title: "Tailscale Serve exposure enabled",
      detail: `gateway.tailscale.mode="serve" exposes the Gateway to your tailnet (loopback behind Tailscale).`,
    });
  }

  if (cfg.gateway?.controlUi?.allowInsecureAuth === true) {
    findings.push({
      checkId: "gateway.control_ui.insecure_auth",
      severity: "warn",
      title: "Control UI insecure auth toggle enabled",
      detail:
        "gateway.controlUi.allowInsecureAuth=true does not bypass secure context or device identity checks; only dangerouslyDisableDeviceAuth disables Control UI device identity checks.",
      remediation: "Disable it or switch to HTTPS (Tailscale Serve) or localhost.",
    });
  }

  if (cfg.gateway?.controlUi?.dangerouslyDisableDeviceAuth === true) {
    findings.push({
      checkId: "gateway.control_ui.device_auth_disabled",
      severity: "critical",
      title: "DANGEROUS: Control UI device auth disabled",
      detail:
        "gateway.controlUi.dangerouslyDisableDeviceAuth=true disables device identity checks for the Control UI.",
      remediation: "Disable it unless you are in a short-lived break-glass scenario.",
    });
  }

  const enabledDangerousFlags = (
    options.collectDangerousConfigFlags ?? collectCoreInsecureOrDangerousFlags
  )(cfg);
  if (enabledDangerousFlags.length > 0) {
    findings.push({
      checkId: "config.insecure_or_dangerous_flags",
      severity: "warn",
      title: "Insecure or dangerous config flags enabled",
      detail: `Detected ${enabledDangerousFlags.length} enabled flag(s): ${enabledDangerousFlags.join(", ")}.`,
      remediation:
        "Disable these flags when not actively debugging, or keep deployment scoped to trusted/local-only networks.",
    });
  }

  const token =
    typeof auth.token === "string" && auth.token.trim().length > 0 ? auth.token.trim() : null;
  if (auth.mode === "token" && token && token.length < 24) {
    findings.push({
      checkId: "gateway.token_too_short",
      severity: "warn",
      title: "Gateway token looks short",
      detail: `gateway auth token is ${token.length} chars; prefer a long random token.`,
    });
  }

  if (auth.mode === "trusted-proxy") {
    const trustedProxies = cfg.gateway?.trustedProxies ?? [];
    const trustedProxyConfig = cfg.gateway?.auth?.trustedProxy;

    findings.push({
      checkId: "gateway.trusted_proxy_auth",
      severity: "critical",
      title: "Trusted-proxy auth mode enabled",
      detail:
        'gateway.auth.mode="trusted-proxy" delegates authentication to a reverse proxy. ' +
        "Ensure your proxy (Pomerium, Caddy, nginx) handles auth correctly and that gateway.trustedProxies " +
        "only contains IPs of your actual proxy servers.",
      remediation:
        "Verify: (1) Your proxy terminates TLS and authenticates users. " +
        "(2) gateway.trustedProxies is restricted to proxy IPs only. " +
        "(3) Direct access to the Gateway port is blocked by firewall. " +
        "See /gateway/trusted-proxy-auth for setup guidance.",
    });

    if (trustedProxies.length === 0) {
      findings.push({
        checkId: "gateway.trusted_proxy_no_proxies",
        severity: "critical",
        title: "Trusted-proxy auth enabled but no trusted proxies configured",
        detail:
          'gateway.auth.mode="trusted-proxy" but gateway.trustedProxies is empty. ' +
          "All requests will be rejected.",
        remediation: "Set gateway.trustedProxies to the IP(s) of your reverse proxy.",
      });
    }

    if (!trustedProxyConfig?.userHeader) {
      findings.push({
        checkId: "gateway.trusted_proxy_no_user_header",
        severity: "critical",
        title: "Trusted-proxy auth missing userHeader config",
        detail:
          'gateway.auth.mode="trusted-proxy" but gateway.auth.trustedProxy.userHeader is not configured.',
        remediation:
          "Set gateway.auth.trustedProxy.userHeader to the header name your proxy uses " +
          '(e.g., "x-forwarded-user", "x-pomerium-claim-email").',
      });
    }

    if (trustedProxyConfig?.allowLoopback === true) {
      findings.push({
        checkId: "gateway.trusted_proxy_allow_loopback",
        severity: "warn",
        title: "Trusted-proxy auth allows loopback proxy sources",
        detail:
          "gateway.auth.trustedProxy.allowLoopback=true allows loopback-source requests " +
          "from configured gateway.trustedProxies entries to satisfy trusted-proxy auth.",
        remediation:
          "Enable this only when a same-host reverse proxy is the intended trust boundary. " +
          "Keep direct Gateway access private to the host and require the proxy to strip or overwrite identity headers.",
      });
    }

    const allowUsers = trustedProxyConfig?.allowUsers ?? [];
    if (allowUsers.length === 0) {
      findings.push({
        checkId: "gateway.trusted_proxy_no_allowlist",
        severity: "warn",
        title: "Trusted-proxy auth allows all authenticated users",
        detail:
          "gateway.auth.trustedProxy.allowUsers is empty, so any user authenticated by your proxy can access the Gateway.",
        remediation:
          "Consider setting gateway.auth.trustedProxy.allowUsers to restrict access to specific users " +
          '(e.g., ["nick@example.com"]).',
      });
    }
  }

  if (bind !== "loopback" && auth.mode !== "trusted-proxy" && !cfg.gateway?.auth?.rateLimit) {
    findings.push({
      checkId: "gateway.auth_no_rate_limit",
      severity: "warn",
      title: "No auth rate limiting configured",
      detail:
        "gateway.bind is not loopback but no gateway.auth.rateLimit is configured. " +
        "Without rate limiting, brute-force auth attacks are not mitigated.",
      remediation:
        "Set gateway.auth.rateLimit (e.g. { maxAttempts: 10, windowMs: 60000, lockoutMs: 300000 }).",
    });
  }

  return findings;
}

// Keep this stricter than isLoopbackAddress on purpose: this check is for
// trust boundaries, so only explicit localhost proxy hops are treated as local.
function isStrictLoopbackTrustedProxyEntry(entry: string): boolean {
  const candidate = entry.trim();
  if (!candidate) {
    return false;
  }
  if (!candidate.includes("/")) {
    return candidate === "127.0.0.1" || candidate.toLowerCase() === "::1";
  }

  const [rawIp, rawPrefix] = candidate.split("/", 2);
  if (!rawIp || !rawPrefix) {
    return false;
  }
  const ipVersion = isIP(rawIp.trim());
  const prefix = Number.parseInt(rawPrefix.trim(), 10);
  if (!Number.isInteger(prefix)) {
    return false;
  }
  if (ipVersion === 4) {
    return rawIp.trim() === "127.0.0.1" && prefix === 32;
  }
  if (ipVersion === 6) {
    return prefix === 128 && normalizeLowercaseStringOrEmpty(rawIp) === "::1";
  }
  return false;
}
