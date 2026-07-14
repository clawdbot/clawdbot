import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
/**
 * Chrome CDP diagnostics.
 *
 * Probes /json/version and WebSocket health, redacts sensitive endpoint data,
 * and formats status output for browser doctor/status flows.
 */
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { rawDataToString } from "../infra/ws.js";
import { redactSensitiveText } from "../logging/redact.js";
import { CHROME_REACHABILITY_TIMEOUT_MS, CHROME_WS_READY_TIMEOUT_MS } from "./cdp-timeouts.js";
import {
  appendCdpPath,
  assertCdpEndpointAllowed,
  fetchCdpChecked,
  isDirectCdpWebSocketEndpoint,
  isWebSocketUrl,
  normalizeCdpHttpBaseForJsonEndpoints,
  openCdpWebSocket,
  redactCdpUrl,
  scopeCdpPolicyToConfiguredEndpoint,
  stripCdpUrlCredentials,
} from "./cdp.helpers.js";
import { normalizeCdpWsUrl } from "./cdp.js";
import { BrowserCdpEndpointBlockedError } from "./errors.js";

/** Machine-readable failure codes for Chrome CDP diagnostics. */
type ChromeCdpDiagnosticCode =
  | "ssrf_blocked"
  | "http_unreachable"
  | "http_status_failed"
  | "invalid_json"
  | "missing_websocket_debugger_url"
  | "websocket_ssrf_blocked"
  | "websocket_handshake_failed"
  | "websocket_health_command_failed"
  | "websocket_health_command_timeout";

/** Result of a Chrome CDP reachability and WebSocket health probe. */
export type ChromeCdpDiagnostic =
  | {
      ok: true;
      cdpUrl: string;
      wsUrl: string;
      browser?: string;
      userAgent?: string;
      elapsedMs: number;
    }
  | {
      ok: false;
      code: ChromeCdpDiagnosticCode;
      cdpUrl: string;
      wsUrl?: string;
      message: string;
      elapsedMs: number;
    };

/** Subset of Chrome /json/version used by browser diagnostics. */
export type ChromeVersion = {
  webSocketDebuggerUrl?: string;
  Browser?: string;
  "User-Agent"?: string;
};

function elapsedSince(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

/** Convert an error and optional cause to redacted diagnostic text. */
export function safeChromeCdpErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? error.cause : undefined;
  const causeMessage =
    cause instanceof Error ? cause.message : typeof cause === "string" ? cause : undefined;
  if (message && causeMessage && !message.includes(causeMessage)) {
    return redactSensitiveText(`${message}: ${causeMessage}`);
  }
  return redactSensitiveText(message || "unknown error");
}

function failureDiagnostic(params: {
  cdpUrl: string;
  code: ChromeCdpDiagnosticCode;
  message: string;
  startedAt: number;
  wsUrl?: string;
}): ChromeCdpDiagnostic {
  return {
    ok: false,
    cdpUrl: params.cdpUrl,
    wsUrl: params.wsUrl,
    code: params.code,
    message: redactSensitiveText(params.message),
    elapsedMs: elapsedSince(params.startedAt),
  };
}

/** Read and validate Chrome's /json/version endpoint. */
async function readChromeVersion(
  cdpUrl: string,
  timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS,
  ssrfPolicy?: SsrFPolicy,
  versionPath = "/json/version",
): Promise<ChromeVersion> {
  const ctrl = new AbortController();
  const t = setTimeout(ctrl.abort.bind(ctrl), timeoutMs);
  try {
    const versionUrl = appendCdpPath(cdpUrl, versionPath);
    const { response, release } = await fetchCdpChecked(
      versionUrl,
      timeoutMs,
      { signal: ctrl.signal },
      ssrfPolicy,
    );
    try {
      const data = await readProviderJsonResponse<ChromeVersion>(response, "cdp-version");
      if (!data || typeof data !== "object") {
        throw new Error("CDP /json/version returned non-object JSON");
      }
      return data;
    } finally {
      await release();
    }
  } finally {
    clearTimeout(t);
  }
}

/** Preserve authenticated providers that expose only Playwright's trailing-slash route. */
export async function readChromeVersionWithCredentialFallback(
  cdpUrl: string,
  timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS,
  ssrfPolicy?: SsrFPolicy,
): Promise<ChromeVersion> {
  try {
    const primaryVersion = await readChromeVersion(cdpUrl, timeoutMs, ssrfPolicy);
    if (
      normalizeOptionalString(primaryVersion.webSocketDebuggerUrl) ||
      stripCdpUrlCredentials(cdpUrl) === cdpUrl
    ) {
      return primaryVersion;
    }
    try {
      return await readChromeVersion(cdpUrl, timeoutMs, ssrfPolicy, "/json/version/");
    } catch {
      return primaryVersion;
    }
  } catch (primaryError) {
    if (stripCdpUrlCredentials(cdpUrl) === cdpUrl) {
      throw primaryError;
    }
    try {
      return await readChromeVersion(cdpUrl, timeoutMs, ssrfPolicy, "/json/version/");
    } catch {
      throw primaryError;
    }
  }
}

type CdpHealthDiagnostic =
  | { ok: true; version?: ChromeVersion }
  | {
      ok: false;
      code:
        | "websocket_handshake_failed"
        | "websocket_health_command_failed"
        | "websocket_health_command_timeout";
      message: string;
    };

function readObjectString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return normalizeOptionalString((value as Record<string, unknown>)[key]);
}

function chromeVersionFromCdpResult(result: unknown): ChromeVersion | undefined {
  const browser = readObjectString(result, "Browser") ?? readObjectString(result, "product");
  const userAgent = readObjectString(result, "User-Agent") ?? readObjectString(result, "userAgent");
  if (!browser && !userAgent) {
    return undefined;
  }
  return {
    Browser: browser,
    "User-Agent": userAgent,
  };
}

async function diagnoseCdpHealthCommand(
  wsUrl: string,
  timeoutMs = CHROME_WS_READY_TIMEOUT_MS,
): Promise<CdpHealthDiagnostic> {
  return await new Promise<CdpHealthDiagnostic>((resolve) => {
    const ws = openCdpWebSocket(wsUrl, {
      handshakeTimeoutMs: timeoutMs,
    });
    let settled = false;
    let opened = false;
    const onMessage = (raw: Parameters<typeof rawDataToString>[0]) => {
      if (settled) {
        return;
      }
      let parsed: { id?: unknown; result?: unknown } | null;
      try {
        parsed = JSON.parse(rawDataToString(raw)) as { id?: unknown; result?: unknown };
      } catch {
        return;
      }
      if (parsed?.id !== 1) {
        return;
      }
      if (parsed.result && typeof parsed.result === "object") {
        finish({ ok: true, version: chromeVersionFromCdpResult(parsed.result) });
        return;
      }
      finish({
        ok: false,
        code: "websocket_health_command_failed",
        message: "Browser.getVersion returned no result object",
      });
    };

    const finish = (value: CdpHealthDiagnostic) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      ws.off("message", onMessage);
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve(value);
    };
    const timer = setTimeout(
      () => {
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        finish({
          ok: false,
          code: opened ? "websocket_health_command_timeout" : "websocket_handshake_failed",
          message: opened
            ? `Browser.getVersion did not respond within ${timeoutMs}ms`
            : `WebSocket handshake did not complete within ${timeoutMs}ms`,
        });
      },
      Math.max(1, timeoutMs + Math.min(25, timeoutMs)),
    );

    ws.once("open", () => {
      opened = true;
      try {
        ws.send(
          JSON.stringify({
            id: 1,
            method: "Browser.getVersion",
          }),
        );
      } catch (err) {
        finish({
          ok: false,
          code: "websocket_health_command_failed",
          message: safeChromeCdpErrorMessage(err),
        });
      }
    });

    ws.on("message", onMessage);

    ws.once("error", (err) => {
      finish({
        ok: false,
        code: opened ? "websocket_health_command_failed" : "websocket_handshake_failed",
        message: safeChromeCdpErrorMessage(err),
      });
    });
    ws.once("close", () => {
      finish({
        ok: false,
        code: opened ? "websocket_health_command_failed" : "websocket_handshake_failed",
        message: opened
          ? "WebSocket closed before Browser.getVersion completed"
          : "WebSocket closed before handshake completed",
      });
    });
  });
}

function classifyChromeVersionError(error: unknown): {
  code: ChromeCdpDiagnosticCode;
  message: string;
} {
  const message = safeChromeCdpErrorMessage(error);
  if (error instanceof BrowserCdpEndpointBlockedError) {
    return { code: "ssrf_blocked", message };
  }
  if (/^HTTP \d+/.test(message)) {
    return { code: "http_status_failed", message };
  }
  if (
    error instanceof SyntaxError ||
    message.includes("cdp-version: malformed JSON response") ||
    message.includes("non-object JSON")
  ) {
    return { code: "invalid_json", message };
  }
  return { code: "http_unreachable", message };
}

/** Format a Chrome CDP diagnostic result for status and doctor output. */
export function formatChromeCdpDiagnostic(diagnostic: ChromeCdpDiagnostic): string {
  const redactedCdpUrl = redactCdpUrl(diagnostic.cdpUrl) ?? diagnostic.cdpUrl;
  const redactedWsUrl = redactCdpUrl(diagnostic.wsUrl) ?? diagnostic.wsUrl;
  if (diagnostic.ok) {
    const browser = diagnostic.browser ? ` browser=${diagnostic.browser}` : "";
    return `CDP diagnostic: ready after ${diagnostic.elapsedMs}ms; cdp=${redactedCdpUrl}; websocket=${redactedWsUrl}.${browser}`;
  }
  const websocket = redactedWsUrl ? `; websocket=${redactedWsUrl}` : "";
  const wslPortproxyHint =
    diagnostic.code === "http_unreachable" && isLikelyEmptyHttpReply(diagnostic.message)
      ? WSL_EMPTY_REPLY_PORTPROXY_HINT
      : "";
  return `CDP diagnostic: ${diagnostic.code} after ${diagnostic.elapsedMs}ms; cdp=${redactedCdpUrl}${websocket}; ${diagnostic.message}.${wslPortproxyHint}`;
}

// The WSL-side error cannot identify which Windows loopback Chrome owns.
// Send operators to the host listeners before they change the proxy family.
const WSL_EMPTY_REPLY_PORTPROXY_HINT =
  " In WSL2-to-Windows Chrome setups, an empty CDP reply can mean netsh is forwarding to the" +
  " wrong loopback address. On Windows, inspect `netstat -ano | findstr :9222` and" +
  " `netsh interface portproxy show all`, then curl both 127.0.0.1 and [::1]. Chromium prefers" +
  " 127.0.0.1 and falls back to [::1] only when the IPv4 bind fails. If svchost/iphlpsvc owns" +
  " 127.0.0.1:9222, remove the 127.0.0.1:9222 -> 127.0.0.1:9222 self-loop; if chrome.exe" +
  " listens only on [::1], use v4tov6 with connectaddress=::1 for the WSL2-reachable listener.";

function isLikelyEmptyHttpReply(message: string): boolean {
  return /empty reply|other side closed|socket closed|connection reset|econnreset|terminated before response/i.test(
    message,
  );
}

async function diagnoseCdpWebSocketEndpoint(params: {
  cdpUrl: string;
  wsUrl: string;
  startedAt: number;
  handshakeTimeoutMs: number;
  version?: ChromeVersion;
}): Promise<ChromeCdpDiagnostic> {
  const health = await diagnoseCdpHealthCommand(params.wsUrl, params.handshakeTimeoutMs);
  if (!health.ok) {
    return failureDiagnostic({
      cdpUrl: params.cdpUrl,
      wsUrl: params.wsUrl,
      code: health.code,
      message: health.message,
      startedAt: params.startedAt,
    });
  }
  return {
    ok: true,
    cdpUrl: params.cdpUrl,
    wsUrl: params.wsUrl,
    browser: params.version?.Browser ?? health.version?.Browser,
    userAgent: params.version?.["User-Agent"] ?? health.version?.["User-Agent"],
    elapsedMs: elapsedSince(params.startedAt),
  };
}

/** Run HTTP and WebSocket health diagnostics for a Chrome CDP endpoint. */
export async function diagnoseChromeCdp(
  cdpUrl: string,
  timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS,
  handshakeTimeoutMs = CHROME_WS_READY_TIMEOUT_MS,
  ssrfPolicy?: SsrFPolicy,
): Promise<ChromeCdpDiagnostic> {
  const startedAt = Date.now();
  try {
    await assertCdpEndpointAllowed(cdpUrl, ssrfPolicy);
  } catch (err) {
    return failureDiagnostic({
      cdpUrl,
      code: "ssrf_blocked",
      message: safeChromeCdpErrorMessage(err),
      startedAt,
    });
  }
  const cdpControlPolicy = scopeCdpPolicyToConfiguredEndpoint(cdpUrl, ssrfPolicy);

  if (isDirectCdpWebSocketEndpoint(cdpUrl)) {
    return await diagnoseCdpWebSocketEndpoint({
      cdpUrl,
      wsUrl: cdpUrl,
      startedAt,
      handshakeTimeoutMs,
    });
  }

  const discoveryUrl = isWebSocketUrl(cdpUrl)
    ? normalizeCdpHttpBaseForJsonEndpoints(cdpUrl)
    : cdpUrl;
  let version: ChromeVersion;
  try {
    version = await readChromeVersionWithCredentialFallback(
      discoveryUrl,
      timeoutMs,
      cdpControlPolicy,
    );
  } catch (err) {
    if (isWebSocketUrl(cdpUrl)) {
      return await diagnoseCdpWebSocketEndpoint({
        cdpUrl,
        wsUrl: cdpUrl,
        startedAt,
        handshakeTimeoutMs,
      });
    }
    const classified = classifyChromeVersionError(err);
    return failureDiagnostic({
      cdpUrl,
      code: classified.code,
      message: classified.message,
      startedAt,
    });
  }

  const wsUrlRaw = normalizeOptionalString(version.webSocketDebuggerUrl) ?? "";
  if (!wsUrlRaw) {
    if (isWebSocketUrl(cdpUrl)) {
      return await diagnoseCdpWebSocketEndpoint({
        cdpUrl,
        wsUrl: cdpUrl,
        startedAt,
        handshakeTimeoutMs,
        version,
      });
    }
    return failureDiagnostic({
      cdpUrl,
      code: "missing_websocket_debugger_url",
      message: "CDP /json/version did not include webSocketDebuggerUrl",
      startedAt,
    });
  }
  const wsUrl = normalizeCdpWsUrl(wsUrlRaw, discoveryUrl);
  try {
    await assertCdpEndpointAllowed(wsUrl, cdpControlPolicy, {
      source: "discovered",
      configuredUrl: cdpUrl,
    });
  } catch (err) {
    return failureDiagnostic({
      cdpUrl,
      wsUrl,
      code: "websocket_ssrf_blocked",
      message: safeChromeCdpErrorMessage(err),
      startedAt,
    });
  }

  const health = await diagnoseCdpHealthCommand(wsUrl, handshakeTimeoutMs);
  if (!health.ok) {
    if (isWebSocketUrl(cdpUrl) && wsUrl !== cdpUrl) {
      const directHealth = await diagnoseCdpHealthCommand(cdpUrl, handshakeTimeoutMs);
      if (directHealth.ok) {
        return {
          ok: true,
          cdpUrl,
          wsUrl: cdpUrl,
          browser: version.Browser,
          userAgent: version["User-Agent"],
          elapsedMs: elapsedSince(startedAt),
        };
      }
    }
    return failureDiagnostic({
      cdpUrl,
      wsUrl,
      code: health.code,
      message: health.message,
      startedAt,
    });
  }

  return {
    ok: true,
    cdpUrl,
    wsUrl,
    browser: version.Browser,
    userAgent: version["User-Agent"],
    elapsedMs: elapsedSince(startedAt),
  };
}
