// Shared dashboard targets, one-time browser pairing, and served-document readiness.
import type { PeerCertificate } from "node:tls";
import { normalizeTlsFingerprint } from "../../packages/gateway-client/src/client-address-utils.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { resolveGatewayPort } from "../config/config.js";
import type { GatewayTlsConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayInteractiveSurfaceAuth } from "../gateway/auth-surface-resolution.js";
import {
  CONTROL_UI_BOOTSTRAP_PROFILE_FRAGMENT_PARAM,
  CONTROL_UI_OWNER_BOOTSTRAP_PROFILE_HINT,
} from "../gateway/control-ui-contract.js";
import { createGatewayCredentialPlan } from "../gateway/credential-planner.js";
import { CONTROL_UI_ASSETS_BUILD_TIMEOUT_MS } from "../infra/control-ui-assets.js";
import { issueDeviceBootstrapToken } from "../infra/device-bootstrap.js";
import { readResponseTextSnippet } from "../infra/http-body.js";
import { fetchConfiguredLocalOriginWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { isSameProcessSpecificIpv4WithLoopbackListeners } from "../infra/ports-format.js";
import { inspectPortUsage } from "../infra/ports-inspect.js";
import { loadGatewayTlsRuntime } from "../infra/tls/gateway.js";
import { CONTROL_UI_OWNER_BOOTSTRAP_PROFILE } from "../shared/device-bootstrap-profile.js";
import { sleep } from "../utils.js";
import { resolveControlUiLinks } from "./onboard-helpers.js";

const CONTROL_UI_DOCUMENT_REQUEST_TIMEOUT_MS = 2_000;
const CONTROL_UI_DOCUMENT_ERROR_MAX_BYTES = 2_048;

/** One canonical target keeps advertised identity, local browser delivery, and document probes distinct. */
export async function resolveControlUiHandoffTarget(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}) {
  const { config, env } = params;
  const port = resolveGatewayPort(config, env);
  const bind = config.gateway?.bind ?? "loopback";
  const basePath = config.gateway?.controlUi?.basePath;
  const customBindHost = config.gateway?.customBindHost;
  const tlsConfig = config.gateway?.tls;
  const tlsEnabled = tlsConfig?.enabled === true;
  const credentialPlan = createGatewayCredentialPlan({ config, env });
  const resolvedAuth = await resolveGatewayInteractiveSurfaceAuth({
    config,
    env,
    surface: "local",
  });
  const authMode =
    config.gateway?.auth?.mode ??
    (credentialPlan.localPassword.value || credentialPlan.envPassword ? "password" : "token");
  const gatewayAuthHandoff =
    authMode === "password" && !credentialPlan.localPassword.hasSecretRef
      ? resolvedAuth.password
      : undefined;

  // Plaintext non-loopback origins lose browser WebCrypto; specific Gateway
  // binds also own a loopback alias, verified before delivering credentials.
  const customBindIsWildcard = bind === "custom" && customBindHost?.trim() === "0.0.0.0";
  const browserBind =
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
    browserBind === bind
      ? configuredLinks
      : resolveControlUiLinks({
          port,
          bind: browserBind,
          customBindHost,
          basePath,
          tlsEnabled,
        });
  const configuredHost = new URL(configuredLinks.wsUrl).hostname;
  const loopbackAliasHost =
    browserBind === "loopback" &&
    (bind === "tailnet" || bind === "custom") &&
    configuredHost !== "127.0.0.1" &&
    configuredHost !== "0.0.0.0"
      ? configuredHost
      : undefined;
  const documentUrl = new URL(links.httpUrl);
  documentUrl.hostname = "127.0.0.1";
  documentUrl.username = "";
  documentUrl.password = "";
  documentUrl.search = "";
  documentUrl.hash = "";

  const token = credentialPlan.localToken.value ?? credentialPlan.envToken ?? "";
  // Legacy JSON consumers still need the shared-token URL for their Gateway RPC;
  // browser delivery separately uses a single-use bootstrap and never this URL.
  const includeTokenInUrl = Boolean(token) && !credentialPlan.localToken.hasSecretRef;
  const dashboardUrl = includeTokenInUrl
    ? `${links.httpUrl}#token=${encodeURIComponent(token)}`
    : links.httpUrl;

  return {
    port,
    basePath,
    bind,
    links,
    authMode,
    gatewayAuthHandoff,
    includeTokenInUrl,
    dashboardUrl,
    documentUrl: documentUrl.toString(),
    probeUrl: loopbackAliasHost ? configuredLinks.wsUrl : links.wsUrl,
    loopbackAliasHost,
    tlsConfig,
  };
}

export type ControlUiHandoffTarget = Awaited<ReturnType<typeof resolveControlUiHandoffTarget>>;

/** Keep shared browser credentials on the same process proven by the configured Gateway endpoint. */
export async function hasVerifiedControlUiLoopbackAlias(target: {
  loopbackAliasHost?: string;
  port: number;
}): Promise<boolean> {
  if (!target.loopbackAliasHost) {
    return true;
  }
  const portUsage = await inspectPortUsage(target.port).catch(() => undefined);
  return Boolean(
    portUsage &&
    isSameProcessSpecificIpv4WithLoopbackListeners(
      portUsage.listeners,
      target.port,
      target.loopbackAliasHost,
    ),
  );
}

/** Mint the Control-UI-scoped one-time device grant immediately before actual delivery. */
export async function issueControlUiBrowserHandoff(httpUrl: string): Promise<{
  browserUrl: string;
  expiresAtMs: number;
}> {
  const issued = await issueDeviceBootstrapToken({
    profile: CONTROL_UI_OWNER_BOOTSTRAP_PROFILE,
  });
  const fragment = new URLSearchParams({
    bootstrapToken: issued.token,
    [CONTROL_UI_BOOTSTRAP_PROFILE_FRAGMENT_PARAM]: CONTROL_UI_OWNER_BOOTSTRAP_PROFILE_HINT,
  });
  return {
    browserUrl: `${httpUrl}#${fragment.toString()}`,
    expiresAtMs: issued.expiresAtMs,
  };
}

type ControlUiDocumentReadiness =
  | { ready: true; tlsFingerprint?: string }
  | { ready: false; reason: string; status?: number };

type ControlUiDocumentReadinessDeps = {
  fetch?: typeof fetchConfiguredLocalOriginWithSsrFGuard;
  loadTls?: typeof loadGatewayTlsRuntime;
  now?: () => number;
  sleep?: (timeoutMs: number) => Promise<void>;
};

/** Wait only for an explicitly preparing dashboard; fail immediately for terminal HTTP states. */
export async function waitForControlUiDocument(params: {
  url: string;
  tlsConfig?: GatewayTlsConfig;
  timeoutMs?: number;
  waitForPending?: boolean;
  onPending?: () => void;
  deps?: ControlUiDocumentReadinessDeps;
}): Promise<ControlUiDocumentReadiness> {
  const now = params.deps?.now ?? Date.now;
  const sleepFor = params.deps?.sleep ?? sleep;
  const deadline = now() + (params.timeoutMs ?? CONTROL_UI_ASSETS_BUILD_TIMEOUT_MS);
  let tlsFingerprint: string | undefined;
  let tlsConnect: Record<string, unknown> | undefined;

  if (params.tlsConfig?.enabled === true) {
    try {
      const tls = await (params.deps?.loadTls ?? loadGatewayTlsRuntime)({
        ...params.tlsConfig,
        autoGenerate: false,
      });
      tlsFingerprint = normalizeTlsFingerprint(tls.fingerprintSha256 ?? "");
      const serverCertificate = tls.tlsOptions?.cert;
      if (!tls.enabled || !tlsFingerprint || !serverCertificate) {
        return {
          ready: false,
          reason: tls.error || "Gateway TLS certificate fingerprint is unavailable.",
        };
      }
      const expectedFingerprint = tlsFingerprint;
      const configuredCa = tls.tlsOptions?.ca;
      // The Gateway CA may verify clients rather than issue its server cert;
      // retain both trust anchors before checking the actual peer fingerprint.
      tlsConnect = {
        ca: configuredCa ? [serverCertificate, configuredCa].flat() : serverCertificate,
        checkServerIdentity: (_hostname: string, certificate: PeerCertificate) =>
          normalizeTlsFingerprint(certificate.fingerprint256 ?? "") === expectedFingerprint
            ? undefined
            : new Error("Gateway TLS certificate fingerprint mismatch."),
      };
    } catch (error) {
      return {
        ready: false,
        reason: error instanceof Error ? error.message : "Gateway TLS certificate is unavailable.",
      };
    }
  }

  let pendingReported = false;
  const origin = new URL(params.url).origin;
  const requestDocument = async (method: "HEAD" | "GET", remainingMs: number) =>
    await (params.deps?.fetch ?? fetchConfiguredLocalOriginWithSsrFGuard)({
      url: params.url,
      configuredLocalOriginBaseUrl: origin,
      policy: { allowedOrigins: [origin] },
      maxRedirects: 0,
      timeoutMs: Math.min(CONTROL_UI_DOCUMENT_REQUEST_TIMEOUT_MS, remainingMs),
      capture: false,
      auditContext: "gateway-control-ui-readiness",
      ...(tlsConnect ? { dispatcherPolicy: { mode: "direct" as const, connect: tlsConnect } } : {}),
      init: {
        method,
        headers: { Accept: "text/html", "Accept-Encoding": "identity" },
      },
    });
  while (true) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      return { ready: false, reason: "Control UI assets did not finish preparing in time." };
    }
    try {
      const request = await requestDocument("HEAD", remainingMs);
      let pendingDelayMs: number | undefined;
      try {
        const mediaType = request.response.headers.get("content-type")?.split(";", 1)[0]?.trim();
        if (request.response.status === 200 && mediaType?.toLowerCase() === "text/html") {
          return { ready: true, ...(tlsFingerprint ? { tlsFingerprint } : {}) };
        }
        const retryAfter = request.response.headers.get("retry-after");
        if (request.response.status !== 503 || !retryAfter || params.waitForPending === false) {
          let detail: string | undefined;
          if (request.response.status === 503 && !retryAfter) {
            // HEAD has no body; one bounded, credential-free GET preserves the
            // Gateway owner's configured-root/build-failure repair diagnostic.
            const diagnostic = await requestDocument("GET", Math.max(1, deadline - now())).catch(
              () => undefined,
            );
            if (diagnostic) {
              try {
                const diagnosticType = diagnostic.response.headers
                  .get("content-type")
                  ?.split(";", 1)[0]
                  ?.trim()
                  .toLowerCase();
                if (diagnostic.response.status === 503 && diagnosticType === "text/plain") {
                  const snippet = await readResponseTextSnippet(diagnostic.response, {
                    maxBytes: CONTROL_UI_DOCUMENT_ERROR_MAX_BYTES,
                    maxChars: CONTROL_UI_DOCUMENT_ERROR_MAX_BYTES,
                    timeoutMs: CONTROL_UI_DOCUMENT_REQUEST_TIMEOUT_MS,
                  });
                  detail = snippet ? sanitizeTerminalText(snippet) : undefined;
                }
              } finally {
                await diagnostic.release();
              }
            }
          }
          return {
            ready: false,
            reason:
              request.response.status === 503 && retryAfter
                ? "Control UI assets are still preparing."
                : detail ||
                  `Control UI dashboard is unavailable (HTTP ${request.response.status}).`,
            status: request.response.status,
          };
        }
        const retryAfterSeconds = Number(retryAfter);
        pendingDelayMs =
          Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? retryAfterSeconds * 1_000
            : 1_000;
      } finally {
        await request.release();
      }
      if (!pendingReported) {
        pendingReported = true;
        params.onPending?.();
      }
      await sleepFor(Math.min(pendingDelayMs, Math.max(0, deadline - now())));
    } catch (error) {
      return {
        ready: false,
        reason: `Control UI dashboard is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
