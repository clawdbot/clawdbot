import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { rawDataToString } from "../infra/ws.js";
import { redactSensitiveText } from "../logging/redact.js";
import { CHROME_REACHABILITY_TIMEOUT_MS, CHROME_WS_READY_TIMEOUT_MS } from "./cdp-timeouts.js";
import {
  appendCdpPath,
  assertCdpEndpointAllowed,
  fetchCdpChecked,
  isWebSocketUrl,
  openCdpWebSocket,
  redactCdpUrl,
} from "./cdp.helpers.js";
import { normalizeCdpWsUrl } from "./cdp.js";
import { BrowserCdpEndpointBlockedError } from "./errors.js";

export type ChromeCdpDiagnosticCode =
  | "ssrf_blocked"
  | "http_unreachable"
  | "http_status_failed"
  | "invalid_json"
  | "missing_websocket_debugger_url"
  | "websocket_ssrf_blocked"
  | "websocket_handshake_failed"
  | "websocket_health_command_failed"
  | "websocket_health_command_timeout";

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

export type ChromeVersion = {
  webSocketDebuggerUrl?: string;
  Browser?: string;
  "User-Agent"?: string;
};

function elapsedSince(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

export function safeChromeCdpErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
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

export async function readChromeVersion(
  cdpUrl: string,
  timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS,
  ssrfPolicy?: SsrFPolicy,
): Promise<ChromeVersion> {
  const ctrl = new AbortController();
  const t = setTimeout(ctrl.abort.bind(ctrl), timeoutMs);
  try {
    const versionUrl = appendCdpPath(cdpUrl, "/json/version");
    const { response, release } = await fetchCdpChecked(
      versionUrl,
      timeoutMs,
      { signal: ctrl.signal },
      ssrfPolicy,
    );
    try {
      const data = (await response.json()) as ChromeVersion;
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

type CdpHealthDiagnostic =
  | { ok: true }
  | {
      ok: false;
      code:
        | "websocket_handshake_failed"
        | "websocket_health_command_failed"
        | "websocket_health_command_timeout";
      message: string;
    };

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
      let parsed: { id?: unknown; result?: unknown } | null = null;
      try {
        parsed = JSON.parse(rawDataToString(raw)) as { id?: unknown; result?: unknown };
      } catch {
        return;
      }
      if (parsed?.id !== 1) {
        return;
      }
      if (parsed.result && typeof parsed.result === "object") {
        finish({ ok: true });
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
  if (error instanceof SyntaxError || message.includes("non-object JSON")) {
    return { code: "invalid_json", message };
  }
  return { code: "http_unreachable", message };
}

export function formatChromeCdpDiagnostic(diagnostic: ChromeCdpDiagnostic): string {
  const redactedCdpUrl = redactCdpUrl(diagnostic.cdpUrl) ?? diagnostic.cdpUrl;
  const redactedWsUrl = redactCdpUrl(diagnostic.wsUrl) ?? diagnostic.wsUrl;
  if (diagnostic.ok) {
    const browser = diagnostic.browser ? ` browser=${diagnostic.browser}` : "";
    return `CDP diagnostic: ready after ${diagnostic.elapsedMs}ms; cdp=${redactedCdpUrl}; websocket=${redactedWsUrl}.${browser}`;
  }
  const websocket = redactedWsUrl ? `; websocket=${redactedWsUrl}` : "";
  return `CDP diagnostic: ${diagnostic.code} after ${diagnostic.elapsedMs}ms; cdp=${redactedCdpUrl}${websocket}; ${diagnostic.message}.`;
}

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

  if (isWebSocketUrl(cdpUrl)) {
    const health = await diagnoseCdpHealthCommand(cdpUrl, handshakeTimeoutMs);
    if (!health.ok) {
      return failureDiagnostic({
        cdpUrl,
        wsUrl: cdpUrl,
        code: health.code,
        message: health.message,
        startedAt,
      });
    }
    return {
      ok: true,
      cdpUrl,
      wsUrl: cdpUrl,
      elapsedMs: elapsedSince(startedAt),
    };
  }

  let version: ChromeVersion;
  try {
    version = await readChromeVersion(cdpUrl, timeoutMs, ssrfPolicy);
  } catch (err) {
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
    return failureDiagnostic({
      cdpUrl,
      code: "missing_websocket_debugger_url",
      message: "CDP /json/version did not include webSocketDebuggerUrl",
      startedAt,
    });
  }
  const wsUrl = normalizeCdpWsUrl(wsUrlRaw, cdpUrl);
  try {
    await assertCdpEndpointAllowed(wsUrl, ssrfPolicy);
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
