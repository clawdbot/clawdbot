/**
 * Guarded provider fetch transport utilities.
 *
 * Applies request timeouts, proxy/TLS overrides, SSRF policy, local-service leases, retry hints, and SSE normalization.
 */
import {
  isCloudMetadataIpAddress,
  isLinkLocalIpAddress,
  parseCanonicalIpAddress,
} from "@openclaw/net-policy/ip";
import {
  asFiniteNumberInRange,
  clampTimerTimeoutMs,
  parseStrictFiniteNumber,
  parseStrictNonNegativeInteger,
} from "@openclaw/normalization-core/number-coercion";
import {
  fetchWithSsrFGuard,
  withTrustedEnvProxyGuardedFetchMode,
} from "../infra/net/fetch-guard.js";
import { shouldUseEnvHttpProxyForUrl } from "../infra/net/proxy-env.js";
import {
  mergeSsrFPolicies,
  ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
  type SsrFPolicy,
} from "../infra/net/ssrf.js";
import type { Model } from "../llm/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveDebugProxySettings } from "../proxy-capture/env.js";
import { emitModelTransportDebug } from "./model-transport-debug.js";
import { formatModelTransportDebugUrl } from "./model-transport-url.js";
import { ProviderHttpError, readResponseTextLimited } from "./provider-http-errors.js";
import {
  ensureModelProviderLocalService,
  type ProviderLocalServiceLease,
} from "./provider-local-service.js";
import {
  buildProviderRequestDispatcherPolicy,
  getModelProviderRequestTransport,
  mergeModelProviderRequestOverrides,
  resolveProviderRequestPolicyConfig,
} from "./provider-request-config.js";

const DEFAULT_MAX_SDK_RETRY_WAIT_SECONDS = 60;
const OPENAI_SDK_STREAM_CONTENT_SNIFF_BYTES = 2 * 1024;
const log = createSubsystemLogger("provider-transport-fetch");

/** Max bytes for an entire JSON body synthesized into SSE frames. Prevents OOM
 *  when a hostile streaming endpoint returns a never-ending JSON response
 *  without Content-Length. */
const SSE_SYNTHESIZE_JSON_MAX_BYTES = 16 * 1024 * 1024;

/** Max decoded characters buffered while waiting for the next SSE event boundary. */
const SSE_SANITIZE_BUFFER_MAX_CHARS = 16 * 1024 * 1024;

const BLOCKED_EXACT_ORIGIN_TRUST_HOSTNAME_LABELS = new Set(["instance-data"]);
const PLAIN_DECIMAL_NUMBER_RE = /^\d+(?:\.\d+)?$/;
const HTTP_DATE_MONTH_INDEX = new Map(
  ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].map(
    (month, index) => [month, index],
  ),
);
const HTTP_DATE_SHORT_WEEKDAY_INDEX = new Map(
  ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((weekday, index) => [weekday, index]),
);
const HTTP_DATE_LONG_WEEKDAY_INDEX = new Map(
  ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map(
    (weekday, index) => [weekday, index],
  ),
);
const IMF_FIXDATE_RE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const OBSOLETE_RFC850_DATE_RE =
  /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const OBSOLETE_ASCTIME_DATE_RE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{2}| \d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

type HttpDateComponents = {
  weekday: number | undefined;
  year: number;
  month: number | undefined;
  day: number;
  hours: number;
  minutes: number;
  seconds: number;
};

function hasReadableSseData(block: string): boolean {
  const dataLines = block
    .split(/\r\n|\n|\r/)
    .filter((line) => line === "data" || line.startsWith("data:"))
    .map((line) => {
      if (line === "data") {
        return "";
      }
      const value = line.slice("data:".length);
      return value.startsWith(" ") ? value.slice(1) : value;
    });
  return dataLines.length > 0 && dataLines.join("\n").trim().length > 0;
}

function findSseEventBoundary(buffer: string): { index: number; length: number } | undefined {
  let best: { index: number; length: number } | undefined;
  for (const delimiter of ["\r\n\r\n", "\n\n", "\r\r"]) {
    const index = buffer.indexOf(delimiter);
    if (index === -1) {
      continue;
    }
    if (!best || index < best.index) {
      best = { index, length: delimiter.length };
    }
  }
  return best;
}

function sanitizeOpenAISdkSseResponse(
  response: Response,
  options?: { synthesizeJsonAsSse?: boolean },
): Response {
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !response.body) {
    return response;
  }
  if (
    options?.synthesizeJsonAsSse === true &&
    (/\bapplication\/json\b/i.test(contentType) || /\+json\b/i.test(contentType))
  ) {
    const source = response.body;
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let buffer = "";
    let totalBytes = 0;
    const sseBody = new ReadableStream<Uint8Array>({
      start() {
        reader = source.getReader();
      },
      async pull(controller) {
        try {
          for (;;) {
            const chunk = await reader?.read();
            if (!chunk || chunk.done) {
              buffer += decoder.decode();
              const data = buffer.trim();
              if (data) {
                controller.enqueue(encoder.encode(`data: ${data}\n\n`));
              }
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
              return;
            }
            const nextTotalBytes = totalBytes + chunk.value.byteLength;
            if (nextTotalBytes > SSE_SYNTHESIZE_JSON_MAX_BYTES) {
              throw new Error(
                `Streaming JSON body exceeded ${SSE_SYNTHESIZE_JSON_MAX_BYTES} bytes while synthesizing SSE frames`,
              );
            }
            totalBytes = nextTotalBytes;
            buffer += decoder.decode(chunk.value, { stream: true });
          }
        } catch (error) {
          await reader?.cancel(error).catch(() => {});
          controller.error(error);
        }
      },
      async cancel(reason) {
        await reader?.cancel(reason);
      },
    });
    const headers = new Headers(response.headers);
    headers.set("content-type", "text/event-stream; charset=utf-8");
    return new Response(sseBody, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  if (!/\btext\/event-stream\b/i.test(contentType)) {
    return response;
  }

  const source = response.body;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let buffer = "";

  const enqueueSanitized = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    text: string,
  ): number => {
    let enqueued = 0;
    buffer += text;
    for (;;) {
      const boundary = findSseEventBoundary(buffer);
      if (!boundary) {
        if (buffer.length > SSE_SANITIZE_BUFFER_MAX_CHARS) {
          throw new Error(
            `SSE response exceeded max buffer size (${SSE_SANITIZE_BUFFER_MAX_CHARS} chars) without event boundary`,
          );
        }
        return enqueued;
      }
      const block = buffer.slice(0, boundary.index);
      const separator = buffer.slice(boundary.index, boundary.index + boundary.length);
      buffer = buffer.slice(boundary.index + boundary.length);
      // OpenAI's SDK currently tries to JSON.parse event-only or blank-data SSE
      // messages. Drop those malformed keepalive-style blocks before it parses.
      if (hasReadableSseData(block)) {
        controller.enqueue(encoder.encode(`${block}${separator}`));
        enqueued += 1;
        return enqueued;
      }
    }
  };

  const sanitizedBody = new ReadableStream<Uint8Array>({
    start() {
      reader = source.getReader();
    },
    async pull(controller) {
      try {
        for (;;) {
          const pending = enqueueSanitized(controller, "");
          if (pending > 0) {
            return;
          }
          const chunk = await reader?.read();
          if (!chunk || chunk.done) {
            const tail = decoder.decode();
            if (tail) {
              enqueueSanitized(controller, tail);
            }
            if (buffer && hasReadableSseData(buffer)) {
              controller.enqueue(encoder.encode(buffer));
            }
            buffer = "";
            controller.close();
            return;
          }
          const enqueued = enqueueSanitized(
            controller,
            decoder.decode(chunk.value, { stream: true }),
          );
          if (enqueued > 0) {
            return;
          }
        }
      } catch (error) {
        await reader?.cancel(error).catch(() => {});
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader?.cancel(reason);
    },
  });

  return new Response(sanitizedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function shouldSanitizeOpenAISdkSseResponse(model: Model): boolean {
  if (model.provider !== "openai") {
    return true;
  }
  try {
    return new URL(model.baseUrl).hostname.toLowerCase() !== "api.openai.com";
  } catch {
    return true;
  }
}

function isJsonContentType(contentType: string): boolean {
  return /\bapplication\/json\b/i.test(contentType) || /\+json\b/i.test(contentType);
}

function isOpenAISdkStreamContentType(contentType: string): boolean {
  return /\btext\/event-stream\b/i.test(contentType) || isJsonContentType(contentType);
}

type OpenAISdkStreamBodyKind = "html" | "json" | "sse" | "unknown";

function classifyOpenAISdkStreamBodyPrefix(text: string): OpenAISdkStreamBodyKind {
  const trimmed = text.replace(/^\uFEFF/u, "").trimStart();
  if (!trimmed) {
    return "unknown";
  }
  if (trimmed.startsWith("<")) {
    return "html";
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return "json";
  }
  if (/^(?::|(?:data|event|id|retry)(?::|\r?\n|\r))/u.test(trimmed)) {
    return "sse";
  }
  const boundary = findSseEventBoundary(text);
  if (boundary && hasReadableSseData(text.slice(0, boundary.index))) {
    return "sse";
  }
  return "unknown";
}

async function classifyOpenAISdkStreamBody(response: Response): Promise<OpenAISdkStreamBodyKind> {
  const reader = response.clone().body?.getReader();
  if (!reader) {
    return "unknown";
  }

  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (total < OPENAI_SDK_STREAM_CONTENT_SNIFF_BYTES) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }
      const remaining = OPENAI_SDK_STREAM_CONTENT_SNIFF_BYTES - total;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      total += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
      const kind = classifyOpenAISdkStreamBodyPrefix(text);
      if (kind !== "unknown") {
        return kind;
      }
    }
    text += decoder.decode();
    return classifyOpenAISdkStreamBodyPrefix(text);
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

function withOpenAISdkStreamContentType(response: Response, contentType: string): Response {
  const headers = new Headers(response.headers);
  headers.set("content-type", contentType);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function normalizeOpenAISdkStreamContentType(params: {
  response: Response;
  model: Model;
  release: () => Promise<void>;
  localServiceLease?: ProviderLocalServiceLease;
}): Promise<Response> {
  const contentType = params.response.headers.get("content-type") ?? "";
  if (!params.response.ok || !params.response.body || isOpenAISdkStreamContentType(contentType)) {
    return params.response;
  }
  if (!contentType.trim()) {
    // ChatGPT Codex can stream valid SSE with no content-type header. Sniff a
    // clone so the SDK still receives the original body once we normalize it.
    const kind = await classifyOpenAISdkStreamBody(params.response).catch(() => "unknown" as const);
    if (kind === "sse") {
      return withOpenAISdkStreamContentType(params.response, "text/event-stream; charset=utf-8");
    }
    if (kind === "json") {
      return withOpenAISdkStreamContentType(params.response, "application/json; charset=utf-8");
    }
  }
  const body = await readResponseTextLimited(params.response).catch(() => "");
  await params.release().catch(() => undefined);
  params.localServiceLease?.release();
  const hint =
    "OpenAI-compatible streamed responses must be text/event-stream or JSON; got " +
    `${contentType || "missing content-type"}. Check the provider baseUrl; ` +
    "OpenAI-compatible APIs commonly require a /v1 path prefix.";
  throw new ProviderHttpError(`${params.model.provider}/${params.model.id}: ${hint}`, {
    status: params.response.status,
    code: "invalid_provider_content_type",
    type: "invalid_response",
    body,
  });
}

async function requestBodyHasStreamTrue(
  request: Request | undefined,
  init: RequestInit | undefined,
): Promise<boolean> {
  const method = request?.method ?? init?.method;
  if (method && method.toUpperCase() !== "POST") {
    return false;
  }
  const headers = request?.headers ?? new Headers(init?.headers);
  const contentType = headers.get("content-type") ?? "";
  if (contentType && !/\bapplication\/json\b/i.test(contentType)) {
    return false;
  }

  let text: string | undefined;
  if (typeof init?.body === "string") {
    text = init.body;
  }
  if (!text) {
    return false;
  }
  try {
    return (JSON.parse(text) as { stream?: unknown }).stream === true;
  } catch {
    return false;
  }
}

function parseRetryAfterSeconds(headers: Headers): number | undefined {
  const retryAfterMs = headers.get("retry-after-ms");
  if (retryAfterMs) {
    const trimmedRetryAfterMs = retryAfterMs.trim();
    if (/^\d+(?:\.\d+)?$/.test(trimmedRetryAfterMs)) {
      const milliseconds = asFiniteNumberInRange(parseStrictFiniteNumber(trimmedRetryAfterMs), {
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
      });
      return milliseconds === undefined ? Number.POSITIVE_INFINITY : milliseconds / 1000;
    }
  }

  const retryAfter = headers.get("retry-after");
  if (!retryAfter) {
    return undefined;
  }

  const trimmedRetryAfterSeconds = retryAfter.trim();
  if (/^\d+$/.test(trimmedRetryAfterSeconds)) {
    return parseStrictNonNegativeInteger(trimmedRetryAfterSeconds) ?? Number.POSITIVE_INFINITY;
  }

  const retryAt = parseRetryAfterHttpDateMs(trimmedRetryAfterSeconds);
  if (retryAt === undefined) {
    return undefined;
  }
  return Math.max(0, (retryAt - Date.now()) / 1000);
}

function parseRetryAfterHttpDateMs(value: string, nowMs = Date.now()): number | undefined {
  const imfFixdate = IMF_FIXDATE_RE.exec(value);
  if (imfFixdate) {
    return parseHttpDateComponentsMs({
      weekday: HTTP_DATE_SHORT_WEEKDAY_INDEX.get(imfFixdate[1] ?? ""),
      year: Number.parseInt(imfFixdate[4] ?? "", 10),
      month: HTTP_DATE_MONTH_INDEX.get(imfFixdate[3] ?? ""),
      day: Number.parseInt(imfFixdate[2] ?? "", 10),
      hours: Number.parseInt(imfFixdate[5] ?? "", 10),
      minutes: Number.parseInt(imfFixdate[6] ?? "", 10),
      seconds: Number.parseInt(imfFixdate[7] ?? "", 10),
    });
  }
  const rfc850Date = OBSOLETE_RFC850_DATE_RE.exec(value);
  if (rfc850Date) {
    const now = new Date(nowMs);
    if (Number.isNaN(now.getTime())) {
      return undefined;
    }
    const candidateYear =
      Math.floor(now.getUTCFullYear() / 100) * 100 + Number.parseInt(rfc850Date[4] ?? "", 10);
    const components = {
      weekday: HTTP_DATE_LONG_WEEKDAY_INDEX.get(rfc850Date[1] ?? ""),
      month: HTTP_DATE_MONTH_INDEX.get(rfc850Date[3] ?? ""),
      day: Number.parseInt(rfc850Date[2] ?? "", 10),
      hours: Number.parseInt(rfc850Date[5] ?? "", 10),
      minutes: Number.parseInt(rfc850Date[6] ?? "", 10),
      seconds: Number.parseInt(rfc850Date[7] ?? "", 10),
    };
    const candidate = parseHttpDateCalendarMs({ year: candidateYear, ...components });
    if (candidate === undefined) {
      return undefined;
    }
    const fiftyYearsFromNow = Date.UTC(
      now.getUTCFullYear() + 50,
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
      now.getUTCMilliseconds(),
    );
    const resolvedYear = candidate > fiftyYearsFromNow ? candidateYear - 100 : candidateYear;
    return parseHttpDateComponentsMs({ year: resolvedYear, ...components });
  }
  const asctimeDate = OBSOLETE_ASCTIME_DATE_RE.exec(value);
  if (!asctimeDate) {
    return undefined;
  }
  return parseHttpDateComponentsMs({
    weekday: HTTP_DATE_SHORT_WEEKDAY_INDEX.get(asctimeDate[1] ?? ""),
    year: Number.parseInt(asctimeDate[7] ?? "", 10),
    month: HTTP_DATE_MONTH_INDEX.get(asctimeDate[2] ?? ""),
    day: Number.parseInt((asctimeDate[3] ?? "").trim(), 10),
    hours: Number.parseInt(asctimeDate[4] ?? "", 10),
    minutes: Number.parseInt(asctimeDate[5] ?? "", 10),
    seconds: Number.parseInt(asctimeDate[6] ?? "", 10),
  });
}

function parseHttpDateComponentsMs(components: HttpDateComponents): number | undefined {
  const timestamp = parseHttpDateCalendarMs(components);
  if (timestamp === undefined) {
    return undefined;
  }
  const weekdayTimestamp = components.seconds === 60 ? timestamp - 1_000 : timestamp;
  return new Date(weekdayTimestamp).getUTCDay() === components.weekday ? timestamp : undefined;
}

function parseHttpDateCalendarMs(
  components: Omit<HttpDateComponents, "weekday">,
): number | undefined {
  const { year, month, day, hours, minutes, seconds } = components;
  if (
    month === undefined ||
    !Number.isInteger(year) ||
    year < 1900 ||
    !Number.isInteger(day) ||
    day < 1 ||
    day > 31 ||
    !Number.isInteger(hours) ||
    hours < 0 ||
    hours > 23 ||
    !Number.isInteger(minutes) ||
    minutes < 0 ||
    minutes > 59 ||
    !Number.isInteger(seconds) ||
    seconds < 0 ||
    seconds > 60
  ) {
    return undefined;
  }
  const calendarSecond = Math.min(seconds, 59);
  const timestamp = Date.UTC(year, month, day, hours, minutes, calendarSecond);
  const parsedDate = new Date(timestamp);
  if (
    parsedDate.getUTCFullYear() !== year ||
    parsedDate.getUTCMonth() !== month ||
    parsedDate.getUTCDate() !== day ||
    parsedDate.getUTCHours() !== hours ||
    parsedDate.getUTCMinutes() !== minutes ||
    parsedDate.getUTCSeconds() !== calendarSecond
  ) {
    return undefined;
  }
  return seconds === 60 ? timestamp + 1_000 : timestamp;
}

function resolveMaxSdkRetryWaitSeconds(): number | undefined {
  const raw = process.env.OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS?.trim();
  if (!raw) {
    return DEFAULT_MAX_SDK_RETRY_WAIT_SECONDS;
  }

  if (/^(?:0|false|off|none|disabled)$/i.test(raw)) {
    return undefined;
  }

  if (!PLAIN_DECIMAL_NUMBER_RE.test(raw)) {
    return DEFAULT_MAX_SDK_RETRY_WAIT_SECONDS;
  }

  const seconds = asFiniteNumberInRange(parseStrictFiniteNumber(raw), {
    min: 0,
    minExclusive: true,
    max: Number.MAX_SAFE_INTEGER,
  });
  if (seconds !== undefined) {
    return seconds;
  }

  return DEFAULT_MAX_SDK_RETRY_WAIT_SECONDS;
}

function shouldBypassLongSdkRetry(response: Response): boolean {
  const maxWaitSeconds = resolveMaxSdkRetryWaitSeconds();
  if (maxWaitSeconds === undefined) {
    return false;
  }

  const status = response.status;
  const stainlessRetryable = status === 408 || status === 409 || status === 429 || status >= 500;
  if (!stainlessRetryable) {
    return false;
  }

  const retryAfterSeconds = parseRetryAfterSeconds(response.headers);
  if (retryAfterSeconds !== undefined) {
    return retryAfterSeconds > maxWaitSeconds;
  }

  return status === 429;
}

const managedStreamCleanupRegistry = new FinalizationRegistry<{ finalize: () => Promise<void> }>(
  (held) => {
    void held.finalize();
  },
);

function buildManagedResponse(
  response: Response,
  release: () => Promise<void>,
  refreshTimeout?: () => void,
  localServiceLease?: ProviderLocalServiceLease,
): Response {
  const finalizeLocalServiceLease = () => {
    localServiceLease?.release();
  };
  if (!response.body) {
    void release().finally(finalizeLocalServiceLease);
    return response;
  }
  const source = response.body;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let released = false;
  const cleanupRegistrationToken = {};
  const finalize = async () => {
    if (released) {
      return;
    }
    released = true;
    managedStreamCleanupRegistry.unregister(cleanupRegistrationToken);
    try {
      await reader?.cancel().catch(() => undefined);
      await release().catch(() => undefined);
    } finally {
      finalizeLocalServiceLease();
    }
  };
  const wrappedBody = new ReadableStream<Uint8Array>({
    start() {
      reader = source.getReader();
    },
    async pull(controller) {
      try {
        const chunk = await reader?.read();
        if (!chunk || chunk.done) {
          controller.close();
          await finalize();
          return;
        }
        refreshTimeout?.();
        controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
        await finalize();
      }
    },
    async cancel(reason) {
      try {
        await reader?.cancel(reason);
      } finally {
        await finalize();
      }
    },
  });
  // Stream consumers should cancel deterministically; this catches abandoned
  // wrapper bodies so guarded dispatchers and local-service leases do not leak.
  managedStreamCleanupRegistry.register(wrappedBody, { finalize }, cleanupRegistrationToken);
  return new Response(wrappedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function resolveModelRequestPolicy(model: Model) {
  const debugProxy = resolveDebugProxySettings();
  let explicitDebugProxyUrl: string | undefined;
  if (debugProxy.enabled && debugProxy.proxyUrl) {
    try {
      if (new URL(model.baseUrl).protocol === "https:") {
        explicitDebugProxyUrl = debugProxy.proxyUrl;
      }
    } catch {
      // Non-URL provider base URLs cannot use the debug proxy override safely.
    }
  }
  const request = mergeModelProviderRequestOverrides(getModelProviderRequestTransport(model), {
    proxy: explicitDebugProxyUrl
      ? {
          mode: "explicit-proxy",
          url: explicitDebugProxyUrl,
        }
      : undefined,
  });
  return resolveProviderRequestPolicyConfig({
    provider: model.provider,
    api: model.api,
    baseUrl: model.baseUrl,
    capability: "llm",
    transport: "stream",
    request,
  });
}

export function resolveModelRequestTimeoutMs(
  model: Model,
  timeoutMs: number | undefined,
): number | undefined {
  if (timeoutMs !== undefined) {
    return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? clampTimerTimeoutMs(timeoutMs)
      : undefined;
  }
  const modelTimeoutMs = (model as { requestTimeoutMs?: unknown }).requestTimeoutMs;
  return typeof modelTimeoutMs === "number" && Number.isFinite(modelTimeoutMs) && modelTimeoutMs > 0
    ? clampTimerTimeoutMs(modelTimeoutMs)
    : undefined;
}

function buildModelRequestSignal(
  baseSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  if (timeoutMs === undefined) {
    return baseSignal;
  }
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!baseSignal) {
    return timeoutSignal;
  }
  return AbortSignal.any([baseSignal, timeoutSignal]);
}

function resolveHttpOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    parsed.hostname = parsed.hostname.replace(/\.+$/, "");
    return parsed.origin.toLowerCase();
  } catch {
    return undefined;
  }
}

function normalizeProviderOriginHostname(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    const normalized = parsed.hostname.trim().toLowerCase().replace(/\.+$/, "");
    return normalized || undefined;
  } catch {
    return undefined;
  }
}

function canImplicitlyTrustConfiguredBaseUrlOrigin(value: unknown): value is string {
  const hostname = normalizeProviderOriginHostname(value);
  if (!hostname) {
    return false;
  }
  const labels = hostname.split(".").filter(Boolean);
  return (
    !labels.some(
      (label) =>
        label.includes("metadata") || BLOCKED_EXACT_ORIGIN_TRUST_HOSTNAME_LABELS.has(label),
    ) &&
    !isLinkLocalIpAddress(hostname) &&
    !isCloudMetadataIpAddress(hostname)
  );
}

function canApplyFakeIpHostnamePolicy(value: unknown): value is string {
  const hostname = normalizeProviderOriginHostname(value);
  if (!hostname) {
    return false;
  }
  const labels = hostname.split(".").filter(Boolean);
  return (
    !labels.some(
      (label) =>
        label.includes("metadata") || BLOCKED_EXACT_ORIGIN_TRUST_HOSTNAME_LABELS.has(label),
    ) && !parseCanonicalIpAddress(hostname)
  );
}

export function resolveProviderTransportSsrFPolicy(params: {
  baseUrl?: string;
  url: string;
  allowPrivateNetwork?: boolean;
  trustConfiguredBaseUrlOrigin?: boolean;
}): SsrFPolicy | undefined {
  const baseUrl = params.baseUrl;
  const baseOrigin = resolveHttpOrigin(baseUrl);
  const requestOrigin = resolveHttpOrigin(params.url);
  const requestMatchesBaseOrigin =
    typeof baseUrl === "string" && Boolean(baseOrigin) && requestOrigin === baseOrigin;
  const baseUrlOriginPolicy =
    requestMatchesBaseOrigin &&
    params.trustConfiguredBaseUrlOrigin &&
    canImplicitlyTrustConfiguredBaseUrlOrigin(baseUrl)
      ? ssrfPolicyFromHttpBaseUrlAllowedOrigin(baseUrl)
      : undefined;
  // Fake-IP trust is hostname-scoped and orthogonal to exact-origin private-IP trust.
  // It is for DNS hostnames only and does not allow literal private IPs by itself.
  const fakeIpPolicy =
    requestMatchesBaseOrigin && canApplyFakeIpHostnamePolicy(baseUrl)
      ? ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist(baseUrl)
      : undefined;
  return mergeSsrFPolicies(
    baseUrlOriginPolicy,
    fakeIpPolicy,
    params.allowPrivateNetwork ? { allowPrivateNetwork: true } : undefined,
  );
}

export function buildGuardedModelFetch(
  model: Model,
  timeoutMs?: number,
  options?: { sanitizeSse?: boolean },
): typeof fetch {
  const requestConfig = resolveModelRequestPolicy(model);
  const dispatcherPolicy = buildProviderRequestDispatcherPolicy(requestConfig);
  const requestTimeoutMs = resolveModelRequestTimeoutMs(model, timeoutMs);
  const summarizeError = (error: unknown): string => {
    if (!error || typeof error !== "object") {
      return `type=${typeof error}`;
    }
    const record = error as Record<string, unknown>;
    const cause =
      record.cause && typeof record.cause === "object"
        ? (record.cause as Record<string, unknown>)
        : undefined;
    const read = (value: unknown) => (typeof value === "string" ? value : typeof value);
    return [
      `name=${read(record.name)}`,
      `code=${read(record.code)}`,
      `causeName=${read(cause?.name)}`,
      `causeCode=${read(cause?.code)}`,
      `message=${error instanceof Error ? error.message : read(record.message)}`,
    ].join(" ");
  };
  return async (input, init) => {
    let localServiceLease: ProviderLocalServiceLease | undefined;
    const request = input instanceof Request ? new Request(input, init) : undefined;
    const url =
      request?.url ??
      (input instanceof URL
        ? input.toString()
        : typeof input === "string"
          ? input
          : (() => {
              throw new Error("Unsupported fetch input for transport-aware model request");
            })());
    const policy = resolveProviderTransportSsrFPolicy({
      baseUrl: model.baseUrl,
      url,
      allowPrivateNetwork: requestConfig.allowPrivateNetwork,
      // Only operator-configured custom/local endpoints get exact-origin trust;
      // known public/native providers keep the default rebinding checks.
      trustConfiguredBaseUrlOrigin:
        !requestConfig.privateNetworkExplicitlyDenied &&
        (requestConfig.policy?.endpointClass === "custom" ||
          requestConfig.policy?.endpointClass === "local"),
    });
    const requestInit =
      request &&
      ({
        method: request.method,
        headers: request.headers,
        body: request.body ?? undefined,
        redirect: request.redirect,
        signal: request.signal,
        ...(request.body ? ({ duplex: "half" } as const) : {}),
      } satisfies RequestInit & { duplex?: "half" });
    const baseInit = requestInit ?? init;
    const synthesizeJsonAsSse = await requestBodyHasStreamTrue(request, baseInit);
    const baseSignal = baseInit?.signal ?? undefined;
    const localServiceSignal = buildModelRequestSignal(baseSignal, requestTimeoutMs);
    const guardedFetchOptions = {
      url,
      init: baseInit,
      capture: {
        meta: {
          provider: model.provider,
          api: model.api,
          model: model.id,
        },
      },
      dispatcherPolicy,
      timeoutMs: requestTimeoutMs,
      ...(baseSignal ? { signal: baseSignal } : {}),
      // Provider transport intentionally keeps the secure default and never
      // replays unsafe request bodies across cross-origin redirects.
      allowCrossOriginUnsafeRedirectReplay: false,
      ...(policy ? { policy } : {}),
    };
    let result: Awaited<ReturnType<typeof fetchWithSsrFGuard>>;
    const fetchStartedAt = Date.now();
    const useEnvProxy = !dispatcherPolicy && shouldUseEnvHttpProxyForUrl(url);
    emitModelTransportDebug(
      log,
      `[model-fetch] start provider=${model.provider} api=${model.api} model=${model.id} ` +
        `method=${baseInit?.method ?? "GET"} url=${formatModelTransportDebugUrl(url)} timeoutMs=${requestTimeoutMs} ` +
        `proxy=${dispatcherPolicy ? "configured" : useEnvProxy ? "env" : "none"} ` +
        `policy=${policy ? "custom" : "default"}`,
    );
    try {
      localServiceLease = await ensureModelProviderLocalService(
        model,
        baseInit?.headers,
        localServiceSignal,
      );
      result = await fetchWithSsrFGuard(
        useEnvProxy
          ? withTrustedEnvProxyGuardedFetchMode(guardedFetchOptions)
          : guardedFetchOptions,
      );
    } catch (error) {
      log.warn(
        `[model-fetch] error provider=${model.provider} api=${model.api} model=${model.id} ` +
          `elapsedMs=${Date.now() - fetchStartedAt} ${summarizeError(error)}`,
      );
      localServiceLease?.release();
      throw error;
    }
    let response = result.response;
    emitModelTransportDebug(
      log,
      `[model-fetch] response provider=${model.provider} api=${model.api} model=${model.id} ` +
        `status=${response.status} elapsedMs=${Date.now() - fetchStartedAt} ` +
        `contentType=${response.headers.get("content-type") ?? ""}`,
    );
    if (shouldBypassLongSdkRetry(response)) {
      const headers = new Headers(response.headers);
      headers.set("x-should-retry", "false");
      response = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    if (synthesizeJsonAsSse && options?.sanitizeSse !== false) {
      response = await normalizeOpenAISdkStreamContentType({
        response,
        model,
        release: result.release,
        localServiceLease,
      });
    }
    response = buildManagedResponse(
      response,
      result.release,
      result.refreshTimeout,
      localServiceLease,
    );
    return options?.sanitizeSse === false || !shouldSanitizeOpenAISdkSseResponse(model)
      ? response
      : sanitizeOpenAISdkSseResponse(response, { synthesizeJsonAsSse });
  };
}
