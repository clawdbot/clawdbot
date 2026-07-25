/**
 * Browser control client transport.
 *
 * Sends requests to either an absolute HTTP browser-control URL or the local
 * in-process dispatcher, adding loopback auth and operator-facing diagnostics.
 */
import { parseBrowserHttpUrl } from "openclaw/plugin-sdk/browser-config";
import {
  extractErrorCode,
  formatErrorMessage,
  toErrorObject,
} from "openclaw/plugin-sdk/error-runtime";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatCliCommand } from "../cli/command-format.js";
import { getRuntimeConfig } from "../config/config.js";
import { isLoopbackHost } from "../gateway/net.js";
import { getBridgeAuthForPort } from "./bridge-auth-registry.js";
import { resolveBrowserConfig, resolveProfile } from "./config.js";
import { resolveBrowserControlAuth } from "./control-auth.js";
import {
  parseBrowserErrorPayload,
  type BrowserNoDisplayErrorMetadata,
  type BrowserNoDisplayErrorDetails,
} from "./errors.js";
import { resolveBrowserRateLimitMessage } from "./rate-limit-message.js";

// Application-level error from the browser control service (service is reachable
// but returned an error response). Must NOT be wrapped with "Can't reach ..." messaging.
export class BrowserServiceError extends Error {
  readonly status?: number;
  readonly reason?: BrowserNoDisplayErrorMetadata["reason"];
  readonly details?: BrowserNoDisplayErrorDetails;

  constructor(message: string, metadata?: BrowserNoDisplayErrorMetadata, status?: number) {
    super(message);
    this.name = "BrowserServiceError";
    this.status = status;
    this.reason = metadata?.reason;
    this.details = metadata?.details;
  }
}

function browserServiceErrorFromPayload(
  value: unknown,
  fallback: string,
  status?: number,
): BrowserServiceError {
  const parsed = parseBrowserErrorPayload(value);
  const message = parsed?.error ?? fallback;
  const modelHint = resolveBrowserServiceModelHint(message, status);
  return new BrowserServiceError(
    modelHint ? appendBrowserToolModelHint(message, modelHint) : message,
    parsed && "reason" in parsed ? parsed : undefined,
    status,
  );
}

type LoopbackBrowserAuthDeps = {
  getRuntimeConfig: typeof getRuntimeConfig;
  resolveBrowserControlAuth: typeof resolveBrowserControlAuth;
  getBridgeAuthForPort: typeof getBridgeAuthForPort;
};

function isAbsoluteHttp(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

function isLoopbackHttpUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

function withLoopbackBrowserAuthImpl(
  url: string,
  init: (RequestInit & { timeoutMs?: number }) | undefined,
  deps: LoopbackBrowserAuthDeps,
): RequestInit & { timeoutMs?: number } {
  const headers = new Headers(init?.headers ?? {});
  if (headers.has("authorization") || headers.has("x-openclaw-password")) {
    return { ...init, headers };
  }
  if (!isLoopbackHttpUrl(url)) {
    return { ...init, headers };
  }

  try {
    const cfg = deps.getRuntimeConfig();
    const auth = deps.resolveBrowserControlAuth(cfg);
    if (auth.token) {
      headers.set("Authorization", `Bearer ${auth.token}`);
      return { ...init, headers };
    }
    if (auth.password) {
      headers.set("x-openclaw-password", auth.password);
      return { ...init, headers };
    }
  } catch {
    // ignore config/auth lookup failures and continue without auth headers
  }

  // Sandbox bridge servers can run with per-process ephemeral auth on dynamic ports.
  // Fall back to the in-memory registry if config auth is not available.
  try {
    const { port } = parseBrowserHttpUrl(url, "browser control URL");
    const bridgeAuth = deps.getBridgeAuthForPort(port);
    if (bridgeAuth?.token) {
      headers.set("Authorization", `Bearer ${bridgeAuth.token}`);
    } else if (bridgeAuth?.password) {
      headers.set("x-openclaw-password", bridgeAuth.password);
    }
  } catch {
    // ignore
  }

  return { ...init, headers };
}

function withLoopbackBrowserAuth(
  url: string,
  init: (RequestInit & { timeoutMs?: number }) | undefined,
): RequestInit & { timeoutMs?: number } {
  return withLoopbackBrowserAuthImpl(url, init, {
    getRuntimeConfig,
    resolveBrowserControlAuth,
    getBridgeAuthForPort,
  });
}

const BROWSER_TOOL_PERSISTENT_MODEL_HINT =
  "Do NOT retry the browser tool — it will keep failing. " +
  "Use an alternative approach or inform the user that the browser is currently unavailable.";
const BROWSER_TOOL_TRANSIENT_MODEL_HINT =
  "This may be a transient browser error. Retry the browser tool once. " +
  "If the same error persists, use an alternative approach or inform the user that the browser is currently unavailable.";

// Retry history already lives in the model transcript. Keep this classifier stateless so one
// session's transient failure cannot suppress browser retries in another session.
const BROWSER_TRANSIENT_NETWORK_ERROR_RE =
  /\b(?:ECONNRESET|ECONNABORTED|ENETRESET|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET))\b|fetch failed|network error|other side closed|socket (?:hang up|terminated)|connection (?:reset|aborted|timed out)/i;
const BROWSER_PERSISTENT_FAILURE_RE =
  /\bECONNREFUSED\b|connection refused|browser control (?:is )?(?:disabled|not enabled)|invalid (?:auth|authentication|credentials|password|token)|authentication (?:failed|required)|unauthorized/i;

const BROWSER_ERROR_BODY_LIMIT_BYTES = 16 * 1024;
// `response/body` supports 5M characters; 32 MiB covers worst-case JSON escaping while staying bounded.
const BROWSER_SUCCESS_BODY_LIMIT_BYTES = 32 * 1024 * 1024;

function isRateLimitStatus(status: number): boolean {
  return status === 429;
}

type BrowserControlOwnership = "local-managed" | "external-browser" | "unknown";

function resolveDispatcherBrowserControlOwnership(url: string): BrowserControlOwnership {
  if (isAbsoluteHttp(url)) {
    return "unknown";
  }
  try {
    const cfg = getRuntimeConfig();
    const resolved = resolveBrowserConfig(cfg?.browser, cfg);
    const parsed = new URL(url, "http://localhost");
    const requestedProfile = parsed.searchParams.get("profile")?.trim();
    const profile = resolveProfile(resolved, requestedProfile || resolved.defaultProfile);
    if (!profile) {
      return "unknown";
    }
    return profile.driver === "openclaw" && profile.cdpIsLoopback && !profile.attachOnly
      ? "local-managed"
      : "external-browser";
  } catch {
    return "unknown";
  }
}

function resolveBrowserFetchOperatorHint(
  url: string,
  opts?: { ownership?: BrowserControlOwnership },
): string {
  if (opts?.ownership === "external-browser") {
    return (
      "The browser profile is external to OpenClaw; make sure its browser/CDP endpoint " +
      "is running and reachable. Restarting the OpenClaw gateway will not launch it."
    );
  }
  const isLocal = !isAbsoluteHttp(url);
  return isLocal
    ? `Restart the OpenClaw gateway (OpenClaw.app menubar, or \`${formatCliCommand("openclaw gateway")}\`).`
    : "If this is a sandboxed session, ensure the sandbox browser is running.";
}

function normalizeErrorMessage(err: unknown): string {
  const message = err instanceof Error ? normalizeOptionalString(err.message) : undefined;
  if (message) {
    return message;
  }
  return String(err);
}

function appendBrowserToolModelHint(message: string, hint: string): string {
  const messageWithoutHints = message
    .replaceAll(BROWSER_TOOL_PERSISTENT_MODEL_HINT, "")
    .replaceAll(BROWSER_TOOL_TRANSIENT_MODEL_HINT, "")
    .trim();
  return `${messageWithoutHints} ${hint}`;
}

type BrowserFetchFailureKind = "timeout" | "aborted" | "transient-network" | "persistent";

function resolveBrowserFetchTimeoutMs(timeoutMs: number | undefined): number {
  return resolveTimerTimeoutMs(timeoutMs, 5000);
}

function classifyBrowserFetchFailure(err: unknown): BrowserFetchFailureKind {
  const directCode = extractErrorCode(err);
  const formatted = formatErrorMessage(err);
  const detail = directCode ? `${formatted} | ${directCode}` : formatted;
  const detailLower = normalizeLowercaseStringOrEmpty(detail);
  const nameLower = err instanceof Error ? normalizeLowercaseStringOrEmpty(err.name) : "";
  if (nameLower === "aborterror") {
    return "aborted";
  }
  if (BROWSER_PERSISTENT_FAILURE_RE.test(detail)) {
    return "persistent";
  }
  const looksLikeTimeout =
    nameLower.includes("timeout") ||
    detailLower.includes("timed out") ||
    detailLower.includes("timeout");
  if (looksLikeTimeout) {
    return "timeout";
  }
  if (BROWSER_TRANSIENT_NETWORK_ERROR_RE.test(detail)) {
    return "transient-network";
  }
  const looksLikeAbort =
    detailLower.includes("aborterror") ||
    detailLower.includes("aborted") ||
    detailLower.includes("abort") ||
    detailLower.includes("cancelled") ||
    detailLower.includes("canceled");
  return looksLikeAbort ? "aborted" : "persistent";
}

function isPersistentBrowserServiceFailure(message: string, status: number | undefined): boolean {
  return status === 401 || BROWSER_PERSISTENT_FAILURE_RE.test(message);
}

function resolveBrowserServiceModelHint(
  message: string,
  status: number | undefined,
): string | undefined {
  if (message.includes(BROWSER_TOOL_PERSISTENT_MODEL_HINT)) {
    return BROWSER_TOOL_PERSISTENT_MODEL_HINT;
  }
  if (message.includes(BROWSER_TOOL_TRANSIENT_MODEL_HINT)) {
    return BROWSER_TOOL_TRANSIENT_MODEL_HINT;
  }
  if (isPersistentBrowserServiceFailure(message, status)) {
    return BROWSER_TOOL_PERSISTENT_MODEL_HINT;
  }
  if (status === 408 || status === 504) {
    return BROWSER_TOOL_TRANSIENT_MODEL_HINT;
  }
  if (status === undefined || status < 500 || status > 599) {
    return undefined;
  }
  const kind = classifyBrowserFetchFailure(new Error(message));
  return kind === "timeout" || kind === "transient-network"
    ? BROWSER_TOOL_TRANSIENT_MODEL_HINT
    : undefined;
}

function resolveBrowserToolModelHint(kind: BrowserFetchFailureKind): string | undefined {
  if (kind === "timeout" || kind === "transient-network") {
    return BROWSER_TOOL_TRANSIENT_MODEL_HINT;
  }
  return kind === "persistent" ? BROWSER_TOOL_PERSISTENT_MODEL_HINT : undefined;
}

async function discardResponseBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Best effort only; we're already returning a stable error message.
  }
}

function enhanceDispatcherPathError(url: string, err: unknown): Error {
  const msg = normalizeErrorMessage(err);
  const kind = classifyBrowserFetchFailure(err);
  const ownership = resolveDispatcherBrowserControlOwnership(url);
  const operatorHint = resolveBrowserFetchOperatorHint(url, { ownership });
  const modelHint = resolveBrowserToolModelHint(kind);
  const suffix = modelHint ? `${operatorHint} ${modelHint}` : operatorHint;
  const normalized = msg.endsWith(".") ? msg : `${msg}.`;
  return new Error(`${normalized} ${suffix}`, err instanceof Error ? { cause: err } : undefined);
}

function enhanceBrowserFetchError(url: string, err: unknown, timeoutMs: number): Error {
  const operatorHint = resolveBrowserFetchOperatorHint(url);
  const msg = normalizeErrorMessage(err);
  const kind = classifyBrowserFetchFailure(err);
  if (kind === "timeout") {
    return new Error(
      `Can't reach the OpenClaw browser control service (timed out after ${timeoutMs}ms). ${operatorHint} ${BROWSER_TOOL_TRANSIENT_MODEL_HINT}`,
      err instanceof Error ? { cause: err } : undefined,
    );
  }
  if (kind === "aborted") {
    return new Error(
      `Browser control request was cancelled. ${operatorHint}`,
      err instanceof Error ? { cause: err } : undefined,
    );
  }
  if (kind === "transient-network") {
    return new Error(
      `Can't reach the OpenClaw browser control service. ${operatorHint} (${msg}) ${BROWSER_TOOL_TRANSIENT_MODEL_HINT}`,
      err instanceof Error ? { cause: err } : undefined,
    );
  }
  return new Error(
    appendBrowserToolModelHint(
      `Can't reach the OpenClaw browser control service. ${operatorHint} (${msg})`,
      BROWSER_TOOL_PERSISTENT_MODEL_HINT,
    ),
    err instanceof Error ? { cause: err } : undefined,
  );
}

async function fetchHttpJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const timeoutMs = resolveBrowserFetchTimeoutMs(init.timeoutMs);
  const ctrl = new AbortController();
  const upstreamSignal = init.signal;
  let upstreamAbortListener: (() => void) | undefined;
  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      ctrl.abort(upstreamSignal.reason);
    } else {
      upstreamAbortListener = () => ctrl.abort(upstreamSignal.reason);
      upstreamSignal.addEventListener("abort", upstreamAbortListener, { once: true });
    }
  }

  const t = setTimeout(() => ctrl.abort(new Error("timed out")), timeoutMs);
  let release: (() => Promise<void>) | undefined;
  try {
    const guarded = await fetchWithSsrFGuard({
      url,
      init,
      // AbortController timer alone does not set Undici connect/headers floors;
      // forward the resolved budget so a hung control peer fails closed via the
      // guarded dispatcher instead of waiting on OS timeouts.
      timeoutMs,
      signal: ctrl.signal,
      policy: { allowPrivateNetwork: true },
      auditContext: "browser-control-client",
    });
    release = guarded.release;
    const res = guarded.response;
    if (!res.ok) {
      if (isRateLimitStatus(res.status)) {
        // Do not reflect upstream response text into the error surface (log/agent injection risk)
        await discardResponseBody(res);
        throw new BrowserServiceError(
          `${resolveBrowserRateLimitMessage(url)} ${BROWSER_TOOL_PERSISTENT_MODEL_HINT}`,
        );
      }
      // Overflow cancels the stream and releases its reader lock before the guarded fetch below.
      const body = await readResponseWithLimit(res, BROWSER_ERROR_BODY_LIMIT_BYTES).catch(
        () => undefined,
      );
      const text = body ? new TextDecoder().decode(body) : "";
      let parsed: unknown;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          // Plain-text errors remain part of the existing browser-control contract.
        }
      }
      throw browserServiceErrorFromPayload(parsed, text || `HTTP ${res.status}`, res.status);
    }
    const body = await readResponseWithLimit(res, BROWSER_SUCCESS_BODY_LIMIT_BYTES, {
      onOverflow: ({ maxBytes }) =>
        new BrowserServiceError(`Browser control response exceeded ${maxBytes} bytes`),
    });
    return JSON.parse(new TextDecoder().decode(body)) as T;
  } finally {
    clearTimeout(t);
    await release?.();
    if (upstreamSignal && upstreamAbortListener) {
      upstreamSignal.removeEventListener("abort", upstreamAbortListener);
    }
  }
}

/** Fetch JSON from browser control over HTTP or local dispatcher transport. */
export async function fetchBrowserJson<T>(
  url: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const timeoutMs = resolveBrowserFetchTimeoutMs(init?.timeoutMs);
  let isDispatcherPath = false;
  try {
    if (isAbsoluteHttp(url)) {
      const httpInit = withLoopbackBrowserAuth(url, init);
      return await fetchHttpJson<T>(url, { ...httpInit, timeoutMs });
    }
    isDispatcherPath = true;
    const { dispatchBrowserControlRequest } = await import("./local-dispatch.runtime.js");
    const parsed = new URL(url, "http://localhost");
    const query: Record<string, unknown> = {};
    for (const [key, value] of parsed.searchParams.entries()) {
      query[key] = value;
    }
    let body = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // keep as string
      }
    }

    const abortCtrl = new AbortController();
    const upstreamSignal = init?.signal;
    let upstreamAbortListener: (() => void) | undefined;
    if (upstreamSignal) {
      if (upstreamSignal.aborted) {
        abortCtrl.abort(upstreamSignal.reason);
      } else {
        upstreamAbortListener = () => abortCtrl.abort(upstreamSignal.reason);
        upstreamSignal.addEventListener("abort", upstreamAbortListener, { once: true });
      }
    }

    let abortListener: (() => void) | undefined;
    const abortPromise: Promise<never> = abortCtrl.signal.aborted
      ? Promise.reject(
          toErrorObject(abortCtrl.signal.reason ?? new Error("aborted"), "Non-Error rejection"),
        )
      : new Promise((_, reject) => {
          abortListener = () =>
            reject(
              toErrorObject(abortCtrl.signal.reason ?? new Error("aborted"), "Non-Error rejection"),
            );
          abortCtrl.signal.addEventListener("abort", abortListener, { once: true });
        });

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs) {
      timer = setTimeout(() => abortCtrl.abort(new Error("timed out")), timeoutMs);
    }

    const dispatchPromise = dispatchBrowserControlRequest({
      method:
        init?.method?.toUpperCase() === "DELETE"
          ? "DELETE"
          : init?.method?.toUpperCase() === "POST"
            ? "POST"
            : "GET",
      path: parsed.pathname,
      query,
      body,
      signal: abortCtrl.signal,
    });

    const result = await Promise.race([dispatchPromise, abortPromise]).finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
      if (abortListener) {
        abortCtrl.signal.removeEventListener("abort", abortListener);
      }
      if (upstreamSignal && upstreamAbortListener) {
        upstreamSignal.removeEventListener("abort", upstreamAbortListener);
      }
    });

    if (result.status >= 400) {
      if (isRateLimitStatus(result.status)) {
        // Do not reflect upstream response text into the error surface (log/agent injection risk)
        throw new BrowserServiceError(
          `${resolveBrowserRateLimitMessage(url)} ${BROWSER_TOOL_PERSISTENT_MODEL_HINT}`,
        );
      }
      throw browserServiceErrorFromPayload(result.body, `HTTP ${result.status}`, result.status);
    }
    return result.body as T;
  } catch (err) {
    if (err instanceof BrowserServiceError) {
      throw err;
    }
    // Dispatcher-path failures are service-operation failures, not network
    // reachability failures. Keep the original context, but retain anti-retry hints.
    if (isDispatcherPath) {
      throw enhanceDispatcherPathError(url, err);
    }
    throw enhanceBrowserFetchError(url, err, timeoutMs);
  }
}
