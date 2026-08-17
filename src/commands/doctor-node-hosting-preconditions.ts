// Doctor node-hosting preconditions expose config combinations that leave browser auth healthy
// while machine authentication or onboarding remains unavailable.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { hasConfiguredGatewayAuthSecretInput } from "../gateway/auth-config-utils.js";

const CHECK_ID = "core/doctor/node-hosting-preconditions";
const LOOPBACK_JOIN_CODE_MESSAGE =
  "Gateway is only bound to loopback. Set gateway.bind=lan, enable tailscale serve, or configure plugins.entries.device-pair.config.publicUrl.";

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function usesIdentityHeadersWithoutMachineCredentials(cfg: OpenClawConfig): boolean {
  const hasToken = hasConfiguredGatewayAuthSecretInput(cfg, "gateway.auth.token");
  const hasPassword = hasConfiguredGatewayAuthSecretInput(cfg, "gateway.auth.password");
  if (hasToken || hasPassword) {
    return false;
  }
  if (cfg.gateway?.auth?.mode === "trusted-proxy") {
    return true;
  }
  return (
    cfg.gateway?.tailscale?.mode === "serve" &&
    cfg.gateway?.auth?.mode !== "password" &&
    cfg.gateway?.auth?.mode !== "none" &&
    cfg.gateway?.auth?.allowTailscale !== false
  );
}

function lacksNodeOnboardingUrl(cfg: OpenClawConfig): boolean {
  const bind = cfg.gateway?.bind ?? "loopback";
  if (bind !== "loopback" && bind !== "auto") {
    return false;
  }
  const publicUrl = cfg.plugins?.entries?.["device-pair"]?.config?.["publicUrl"];
  const remoteUrl = cfg.gateway?.remote?.url;
  const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
  return (
    !hasNonEmptyString(publicUrl) &&
    !hasNonEmptyString(remoteUrl) &&
    tailscaleMode !== "serve" &&
    tailscaleMode !== "funnel"
  );
}

/** Collects config-only warnings for node authentication, onboarding, and worker ingress. */
export function collectNodeHostingPreconditionFindings(
  cfg: OpenClawConfig,
): readonly HealthFinding[] {
  const findings: HealthFinding[] = [];
  if (usesIdentityHeadersWithoutMachineCredentials(cfg)) {
    findings.push({
      checkId: CHECK_ID,
      severity: "warning",
      message:
        "Gateway identity-header auth has no configured token/password path for machine clients; new node hosts cannot authenticate or become worker hosts.",
      path: "gateway.auth",
      requirement: "machine-client-auth",
      fixHint:
        "Switch gateway.auth.mode to token and configure gateway.auth.token as a SecretRef so machine clients can authenticate as devices. Keep trusted-proxy only if machine clients use a clean loopback/direct gateway.auth.password path. Cloudflare Access service tokens are the alternative for Access-fronted gateways, but node-host support for CF-Access-Client-Id / CF-Access-Client-Secret is not implemented yet.",
    });
  }
  if (lacksNodeOnboardingUrl(cfg)) {
    findings.push({
      checkId: CHECK_ID,
      severity: "warning",
      message: LOOPBACK_JOIN_CODE_MESSAGE,
      path: "gateway.bind",
      requirement: "node-onboarding-url",
      fixHint:
        "If an edge proxy fronts node onboarding, allow /j/* and /__openclaw__/worker without edge identity auth, and preserve WebSocket upgrade on /__openclaw__/worker. Both routes enforce their own credentials.",
    });
  }
  return findings;
}
