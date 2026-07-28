// Implements `openclaw dashboard` URL resolution, readiness check, clipboard, and browser launch.
import { readConfigFileSnapshot, resolveGatewayPort } from "../config/config.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { resolveGatewayAuthToken } from "../gateway/auth-token-resolution.js";
import { resolveGatewayAuth } from "../gateway/auth.js";
import { copyToClipboard } from "../infra/clipboard.js";
import { isSameProcessSpecificIpv4WithLoopbackListeners } from "../infra/ports-format.js";
import { inspectPortUsage } from "../infra/ports-inspect.js";
import { loadGatewayTlsRuntime } from "../infra/tls/gateway.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { ensureGatewayReadyForOperation } from "./gateway-readiness.js";
import {
  detectBrowserOpenSupport,
  formatControlUiSshHint,
  openUrl,
  resolveControlUiLinks,
} from "./onboard-helpers.js";

type DashboardOptions = {
  json?: boolean;
  noOpen?: boolean;
  yes?: boolean;
};

const quietRuntime: RuntimeEnv = {
  log: () => {},
  error: () => {},
  exit: () => {},
};

const gatewayPasswordJsonKey = ["gateway", "Password"].join("");

async function resolveDashboardTarget() {
  const snapshot = await readConfigFileSnapshot();
  const cfg = snapshot.valid ? (snapshot.sourceConfig ?? snapshot.config) : {};
  const port = resolveGatewayPort(cfg);
  const bind = cfg.gateway?.bind ?? "loopback";
  const basePath = cfg.gateway?.controlUi?.basePath;
  const customBindHost = cfg.gateway?.customBindHost;
  const resolvedToken = await resolveGatewayAuthToken({
    cfg,
    env: process.env,
    envFallback: "always",
  });
  const token = resolvedToken.token ?? "";
  const resolvedGatewayAuth = resolveGatewayAuth({
    authConfig: cfg.gateway?.auth,
    env: process.env,
    tailscaleMode: cfg.gateway?.tailscale?.mode,
  });
  const passwordSecretRefConfigured = Boolean(
    resolveSecretInputRef({
      value: cfg.gateway?.auth?.password,
      defaults: cfg.secrets?.defaults,
    }).ref,
  );
  const gatewayAuthHandoff =
    resolvedGatewayAuth.mode === "password" && !passwordSecretRefConfigured
      ? resolvedGatewayAuth.password
      : undefined;

  const tlsConfig = cfg.gateway?.tls;
  const tlsEnabled = tlsConfig?.enabled === true;
  // A wildcard LAN address is not a browser destination, while plain HTTP on a
  // specific interface fails secure-context checks. Same-host launches use loopback;
  // TLS keeps specific hosts so certificate names continue to match.
  const customBindIsWildcard = bind === "custom" && customBindHost?.trim() === "0.0.0.0";
  const dashboardBind =
    bind === "lan" ||
    customBindIsWildcard ||
    (!tlsEnabled && (bind === "tailnet" || bind === "custom"))
      ? "loopback"
      : bind;
  const configuredLinks = resolveControlUiLinks({
    port,
    bind,
    customBindHost,
    basePath,
    tlsEnabled,
  });
  const links =
    dashboardBind === bind
      ? configuredLinks
      : resolveControlUiLinks({
          port,
          bind: dashboardBind,
          customBindHost,
          basePath,
          tlsEnabled,
        });
  const loopbackAliasHost = (() => {
    if (dashboardBind !== "loopback" || (bind !== "tailnet" && bind !== "custom")) {
      return undefined;
    }
    try {
      const host = new URL(configuredLinks.wsUrl).hostname;
      return host === "127.0.0.1" || host === "0.0.0.0" ? undefined : host;
    } catch {
      return undefined;
    }
  })();
  // Avoid embedding externally managed SecretRef tokens in terminal/clipboard/browser args.
  const includeTokenInUrl = token.length > 0 && !resolvedToken.secretRefConfigured;
  // Prefer URL fragment to avoid leaking auth tokens via query params.
  const dashboardUrl = includeTokenInUrl
    ? `${links.httpUrl}#token=${encodeURIComponent(token)}`
    : links.httpUrl;

  return {
    port,
    basePath,
    links,
    resolvedToken,
    token,
    gatewayAuthHandoff,
    includeTokenInUrl,
    dashboardUrl,
    probeUrl: loopbackAliasHost ? configuredLinks.wsUrl : links.wsUrl,
    loopbackAliasHost,
    tlsConfig,
    tlsEnabled,
  };
}

async function hasVerifiedLoopbackAlias(
  target: Awaited<ReturnType<typeof resolveDashboardTarget>>,
): Promise<boolean> {
  const expectedHost = target.loopbackAliasHost;
  if (!expectedHost) {
    return true;
  }
  const portUsage = await inspectPortUsage(target.port).catch(() => undefined);
  // The configured-address probe establishes Gateway identity. This local PID check only proves
  // that the process also owns the loopback endpoint before credentials are delivered there.
  return Boolean(
    portUsage &&
    isSameProcessSpecificIpv4WithLoopbackListeners(portUsage.listeners, target.port, expectedHost),
  );
}

async function ensureDashboardTargetReady(params: {
  target: Awaited<ReturnType<typeof resolveDashboardTarget>>;
  runtime: RuntimeEnv;
  yes?: boolean;
  allowRecovery?: boolean;
}) {
  return ensureGatewayReadyForOperation({
    runtime: params.runtime,
    operation: "open the dashboard",
    yes: params.yes,
    probeUrl: params.target.probeUrl,
    // First-time CLI probes intentionally lack paired operator scope. Gateway
    // handshake evidence plus the same-PID alias check below proves the target.
    readyWhenReachable: true,
    ...(params.allowRecovery === false ? { allowInstall: false, interactive: false } : {}),
  });
}

function dashboardJsonFailure(runtime: RuntimeEnv, reason: string): void {
  writeRuntimeJson(runtime, { ok: false, reason }, 0);
  runtime.exit(1);
}

async function dashboardJsonCommand(runtime: RuntimeEnv): Promise<void> {
  try {
    const target = await resolveDashboardTarget();
    const readiness = await ensureDashboardTargetReady({
      target,
      runtime: quietRuntime,
      allowRecovery: false,
    });
    if (!readiness.ready) {
      dashboardJsonFailure(runtime, readiness.reason);
      return;
    }
    if (!(await hasVerifiedLoopbackAlias(target))) {
      dashboardJsonFailure(
        runtime,
        "Dashboard loopback listener could not be verified as the configured Gateway.",
      );
      return;
    }

    let tlsFingerprint: string | undefined;
    if (target.tlsEnabled) {
      const tlsRuntime = await loadGatewayTlsRuntime(target.tlsConfig);
      if (!tlsRuntime.enabled || !tlsRuntime.fingerprintSha256) {
        dashboardJsonFailure(
          runtime,
          tlsRuntime.error || "Gateway TLS certificate fingerprint is unavailable.",
        );
        return;
      }
      tlsFingerprint = tlsRuntime.fingerprintSha256;
    }

    writeRuntimeJson(
      runtime,
      {
        ok: true,
        url: target.dashboardUrl,
        httpUrl: target.links.httpUrl,
        wsUrl: target.links.wsUrl,
        port: target.port,
        tokenIncluded: target.includeTokenInUrl,
        ...(target.gatewayAuthHandoff
          ? { [gatewayPasswordJsonKey]: target.gatewayAuthHandoff }
          : {}),
        ...(tlsFingerprint ? { tlsFingerprint } : {}),
      },
      0,
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    dashboardJsonFailure(runtime, reason || "Dashboard target resolution failed.");
  }
}

/** Open or print the Control UI dashboard URL after ensuring the Gateway is reachable. */
export async function dashboardCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: DashboardOptions = {},
) {
  if (options.json) {
    await dashboardJsonCommand(runtime);
    return;
  }

  const initialTarget = await resolveDashboardTarget();
  const readiness = await ensureDashboardTargetReady({
    target: initialTarget,
    runtime,
    yes: options.yes,
  });
  if (!readiness.ready) {
    return;
  }

  const target = readiness.recovered ? await resolveDashboardTarget() : initialTarget;
  const recoveryChangedProbe = target.probeUrl !== initialTarget.probeUrl;
  if (readiness.recovered && recoveryChangedProbe) {
    // Recovery may install or start against a changed config. Prove the final
    // endpoint without triggering a second lifecycle action before URL delivery.
    const finalReadiness = await ensureDashboardTargetReady({
      target,
      runtime,
      allowRecovery: false,
    });
    if (!finalReadiness.ready) {
      return;
    }
  }
  if (!(await hasVerifiedLoopbackAlias(target))) {
    runtime.error(
      "Dashboard loopback listener could not be verified as the configured Gateway; refusing to copy or open an authenticated URL.",
    );
    runtime.log("Restart the Gateway, then run `openclaw gateway status --deep` for details.");
    return;
  }
  const { port, basePath, links, resolvedToken, token, includeTokenInUrl, dashboardUrl } = target;

  runtime.log(`Dashboard URL: ${links.httpUrl}`);
  if (includeTokenInUrl) {
    runtime.log("Token auto-auth included in browser/clipboard URL.");
  }
  if (resolvedToken.secretRefConfigured && token) {
    runtime.log(
      "Token auto-auth is disabled for SecretRef-managed gateway.auth.token; use your external token source if prompted.",
    );
  }
  if (resolvedToken.unresolvedRefReason) {
    runtime.log(`Token auto-auth unavailable: ${resolvedToken.unresolvedRefReason}`);
    runtime.log(
      "Set OPENCLAW_GATEWAY_TOKEN in this shell or resolve your secret provider, then rerun `openclaw dashboard`.",
    );
  }

  const copied = await copyToClipboard(dashboardUrl).catch(() => false);
  runtime.log(copied ? "Copied to clipboard." : "Copy to clipboard unavailable.");

  let opened = false;
  let hint: string | undefined;
  if (!options.noOpen) {
    const browserSupport = await detectBrowserOpenSupport();
    if (browserSupport.ok) {
      opened = await openUrl(dashboardUrl);
    }
    if (!opened) {
      hint = formatControlUiSshHint({
        port,
        basePath,
      });
    }
  } else {
    hint =
      copied && includeTokenInUrl
        ? "Browser launch disabled (--no-open). Token-authenticated URL copied to clipboard."
        : "Browser launch disabled (--no-open). Use the URL above.";
  }

  const fallbackToManualAuth = !copied && !opened && includeTokenInUrl;
  const suppressNoOpenHint = options.noOpen === true && fallbackToManualAuth;

  if (opened) {
    runtime.log("Opened in your browser. Keep that tab to control OpenClaw.");
  } else if (hint && !suppressNoOpenHint) {
    runtime.log(hint);
  }

  if (fallbackToManualAuth) {
    runtime.log(
      "Token auto-auth not delivered. Append your gateway token (from OPENCLAW_GATEWAY_TOKEN or gateway.auth.token) as a URL fragment with key `token` to authenticate.",
    );
  }
}
