// Vydra plugin module implements shared behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { extensionForMime, type MediaKind } from "openclaw/plugin-sdk/media-mime";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  createProviderOperationDeadline,
  createProviderOperationTimeoutResolver,
  fetchWithTimeoutGuarded,
  pollProviderOperationJson,
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
  type ProviderOperationDeadline,
  type ProviderOperationTimeoutMs,
} from "openclaw/plugin-sdk/provider-http";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import type { SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

export const DEFAULT_VYDRA_BASE_URL = "https://www.vydra.ai/api/v1";
export const DEFAULT_VYDRA_IMAGE_MODEL = "grok-imagine";
export const DEFAULT_VYDRA_VIDEO_MODEL = "veo3";
export const DEFAULT_VYDRA_SPEECH_MODEL = "elevenlabs/tts";
export const DEFAULT_VYDRA_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";
const DEFAULT_HTTP_TIMEOUT_MS = 120_000;
const DEFAULT_GENERATED_IMAGE_MAX_BYTES = 6 * 1024 * 1024;
const DEFAULT_GENERATED_AUDIO_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_GENERATED_VIDEO_MAX_BYTES = 16 * 1024 * 1024;
const POLL_INTERVAL_MS = 2_500;
const MAX_POLL_ATTEMPTS = 120;
type VydraAuthStore = Parameters<typeof resolveApiKeyForProvider>[0]["store"];

type VydraRequestPolicy = Pick<
  ReturnType<typeof resolveProviderHttpRequestConfig>,
  "allowPrivateNetwork" | "dispatcherPolicy" | "headers"
> & {
  headerOrigin: string;
  ssrfPolicy?: SsrFPolicy;
};

type VydraMediaKind = Extract<MediaKind, "audio" | "image" | "video">;

type VydraJobPayload = {
  id?: string;
  jobId?: string;
  status?: string;
  message?: string;
  error?: string | { message?: string; detail?: string } | null;
};

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function addUrlValue(value: unknown, urls: Set<string>): void {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^https?:\/\//iu.test(trimmed)) {
      urls.add(trimmed);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      addUrlValue(entry, urls);
    }
  }
}

export const trimToUndefined = normalizeOptionalString;

export function normalizeVydraBaseUrl(value: string | undefined): string {
  const fallback = DEFAULT_VYDRA_BASE_URL;
  const trimmed = trimToUndefined(value);
  if (!trimmed) {
    return fallback;
  }
  try {
    const url = new URL(trimmed);
    if (url.hostname === "vydra.ai") {
      url.hostname = "www.vydra.ai";
    }
    const pathname = url.pathname.replace(/\/+$/u, "");
    if (!pathname) {
      url.pathname = "/api/v1";
    } else {
      url.pathname = pathname;
    }
    return url.toString().replace(/\/$/u, "");
  } catch {
    return fallback;
  }
}

function resolveVydraBaseUrlFromConfig(cfg: unknown): string {
  const models = asObject(asObject(cfg)?.models);
  const providers = asObject(models?.providers);
  const vydra = asObject(providers?.vydra);
  return normalizeVydraBaseUrl(trimToUndefined(vydra?.baseUrl));
}

export async function resolveVydraRequestContext(params: {
  cfg: OpenClawConfig;
  agentDir?: string;
  authStore?: VydraAuthStore;
  capability: "image" | "video";
  ssrfPolicy?: SsrFPolicy;
}): Promise<{
  fetchFn: typeof fetch;
  baseUrl: string;
  requestPolicy: VydraRequestPolicy;
}> {
  const auth = await resolveApiKeyForProvider({
    provider: "vydra",
    cfg: params.cfg,
    agentDir: params.agentDir,
    store: params.authStore,
  });
  if (!auth.apiKey) {
    throw new Error("Vydra API key missing");
  }
  const fetchFn = fetch;
  const providerConfig = params.cfg.models?.providers?.vydra;
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveProviderHttpRequestConfig({
      baseUrl: resolveVydraBaseUrlFromConfig(params.cfg),
      defaultBaseUrl: DEFAULT_VYDRA_BASE_URL,
      defaultHeaders: {
        Authorization: `Bearer ${auth.apiKey}`,
        "Content-Type": "application/json",
      },
      provider: "vydra",
      capability: params.capability,
      transport: "http",
      request: sanitizeConfiguredModelProviderRequest(providerConfig?.request),
    });
  return {
    fetchFn,
    baseUrl,
    requestPolicy: {
      allowPrivateNetwork,
      dispatcherPolicy,
      headers,
      headerOrigin: new URL(baseUrl).origin,
      ...(params.ssrfPolicy ? { ssrfPolicy: params.ssrfPolicy } : {}),
    },
  };
}

export function resolveVydraResponseJobId(payload: unknown): string | undefined {
  const object = asObject(payload) as VydraJobPayload | undefined;
  return trimToUndefined(object?.jobId) ?? trimToUndefined(object?.id);
}

export function resolveVydraResponseStatus(payload: unknown): string | undefined {
  return normalizeOptionalLowercaseString(trimToUndefined(asObject(payload)?.status));
}

function resolveVydraErrorMessage(payload: unknown): string | undefined {
  const object = asObject(payload) as VydraJobPayload | undefined;
  const error = object?.error;
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  const errorObject = asObject(error);
  return (
    trimToUndefined(errorObject?.message) ??
    trimToUndefined(errorObject?.detail) ??
    trimToUndefined(object?.message)
  );
}

export function extractVydraResultUrls(payload: unknown, kind: VydraMediaKind): string[] {
  const urls = new Set<string>();
  const preferredKeys =
    kind === "audio"
      ? ["audioUrl", "audioUrls"]
      : kind === "image"
        ? ["imageUrl", "imageUrls"]
        : ["videoUrl", "videoUrls"];
  const sharedKeys = ["resultUrl", "resultUrls", "outputUrl", "outputUrls", "url", "urls"];
  const recurseKeys = ["output", "outputs", "result", "results", "data", "asset", "assets"];

  const visit = (value: unknown, depth = 0) => {
    if (depth > 5) {
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry, depth + 1);
      }
      return;
    }
    const object = asObject(value);
    if (!object) {
      return;
    }
    for (const key of [...preferredKeys, ...sharedKeys]) {
      addUrlValue(object[key], urls);
    }
    for (const key of recurseKeys) {
      if (key in object) {
        visit(object[key], depth + 1);
      }
    }
  };

  visit(payload);
  return [...urls];
}

function resolveVydraFileExtension(kind: VydraMediaKind, mimeType: string): string {
  return (
    extensionForMime(mimeType)?.slice(1) ??
    (kind === "image" ? "png" : kind === "audio" ? "mp3" : "mp4")
  );
}

function resolveVydraHttpTimeoutMs(timeoutMs: ProviderOperationTimeoutMs | undefined): number {
  const resolved = typeof timeoutMs === "function" ? timeoutMs() : timeoutMs;
  if (typeof resolved !== "number" || !Number.isFinite(resolved) || resolved <= 0) {
    return DEFAULT_HTTP_TIMEOUT_MS;
  }
  return resolved;
}

function createVydraTimeoutError(deadline: ProviderOperationDeadline): Error {
  const timeoutLabel =
    typeof deadline.timeoutMs === "number" ? ` after ${deadline.timeoutMs}ms` : "";
  return new Error(`${deadline.label} timed out${timeoutLabel}`);
}

function resolveVydraGuardedRequestOptions(
  policy: VydraRequestPolicy,
): NonNullable<Parameters<typeof fetchWithTimeoutGuarded>[4]> {
  const ssrfPolicy = policy.allowPrivateNetwork
    ? { ...policy.ssrfPolicy, allowPrivateNetwork: true }
    : policy.ssrfPolicy;
  return {
    ...(ssrfPolicy ? { ssrfPolicy } : {}),
    ...(policy.dispatcherPolicy ? { dispatcherPolicy: policy.dispatcherPolicy } : {}),
    auditContext: "vydra-media-download",
  };
}

function resolveVydraAssetRequestHeaders(
  url: string,
  policy: VydraRequestPolicy,
): Headers | undefined {
  try {
    // Same-origin assets may need the configured provider headers. Cross-origin
    // result URLs must not receive the Vydra API credential or custom headers.
    return new URL(url).origin === policy.headerOrigin ? policy.headers : undefined;
  } catch {
    return undefined;
  }
}

export function resolveVydraGeneratedMediaMaxBytes(params: {
  cfg: { agents?: { defaults?: { mediaMaxMb?: number } } };
  kind: VydraMediaKind;
}): number {
  const configured = params.cfg.agents?.defaults?.mediaMaxMb;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured * 1024 * 1024);
  }
  if (params.kind === "image") {
    return DEFAULT_GENERATED_IMAGE_MAX_BYTES;
  }
  if (params.kind === "audio") {
    return DEFAULT_GENERATED_AUDIO_MAX_BYTES;
  }
  return DEFAULT_GENERATED_VIDEO_MAX_BYTES;
}

export async function downloadVydraAsset(params: {
  url: string;
  kind: VydraMediaKind;
  timeoutMs?: ProviderOperationTimeoutMs;
  fetchFn: typeof fetch;
  maxBytes: number;
  requestPolicy: VydraRequestPolicy;
}): Promise<{ buffer: Buffer; mimeType: string; fileName: string }> {
  const timeoutMs = resolveVydraHttpTimeoutMs(params.timeoutMs);
  const deadline = createProviderOperationDeadline({
    timeoutMs,
    label: `Vydra ${params.kind} download`,
  });
  const resolveTimeoutMs = createProviderOperationTimeoutResolver({
    deadline,
    defaultTimeoutMs: timeoutMs,
  });
  const headers = resolveVydraAssetRequestHeaders(params.url, params.requestPolicy);
  const result = await fetchWithTimeoutGuarded(
    params.url,
    {
      method: "GET",
      ...(headers ? { headers } : {}),
    },
    resolveTimeoutMs(),
    params.fetchFn,
    resolveVydraGuardedRequestOptions(params.requestPolicy),
  );
  try {
    try {
      await assertOkOrThrowHttpError(result.response, `Vydra ${params.kind} download failed`, {
        bodyTimeoutMs: resolveTimeoutMs,
        onBodyTimeout: () => createVydraTimeoutError(deadline),
      });
      const mimeType =
        result.response.headers.get("content-type")?.trim() ||
        (params.kind === "image"
          ? "image/png"
          : params.kind === "audio"
            ? "audio/mpeg"
            : "video/mp4");
      const buffer = await readResponseWithLimit(result.response, params.maxBytes, {
        timeoutMs: resolveTimeoutMs,
        onTimeout: () => createVydraTimeoutError(deadline),
        onOverflow: ({ maxBytes }) =>
          new Error(`Vydra ${params.kind} download exceeds ${maxBytes} bytes`),
      });
      const extension = resolveVydraFileExtension(params.kind, mimeType);
      const fileStem =
        params.kind === "image" ? "image" : params.kind === "audio" ? "audio" : "video";
      return {
        buffer,
        mimeType,
        fileName: `${fileStem}-1.${extension}`,
      };
    } catch (error) {
      // The guarded request signal remains active through body consumption and
      // can win the same absolute-deadline race. Keep timeout precedence stable.
      if (typeof deadline.deadlineAtMs === "number" && Date.now() >= deadline.deadlineAtMs) {
        throw createVydraTimeoutError(deadline);
      }
      throw error;
    }
  } finally {
    await result.release();
  }
}

async function waitForVydraJob(params: {
  baseUrl: string;
  jobId: string;
  timeoutMs?: number;
  deadline?: ProviderOperationDeadline;
  fetchFn: typeof fetch;
  kind: VydraMediaKind;
  requestPolicy: VydraRequestPolicy;
}): Promise<unknown> {
  const deadline =
    params.deadline ??
    createProviderOperationDeadline({
      timeoutMs: params.timeoutMs,
      label: `Vydra job ${params.jobId}`,
    });
  return await pollProviderOperationJson<unknown>({
    url: `${params.baseUrl}/jobs/${params.jobId}`,
    headers: params.requestPolicy.headers,
    deadline,
    defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
    fetchFn: params.fetchFn,
    maxAttempts: MAX_POLL_ATTEMPTS,
    pollIntervalMs: POLL_INTERVAL_MS,
    requestFailedMessage: "Vydra job status request failed",
    timeoutMessage: `Vydra job ${params.jobId} did not finish in time`,
    allowPrivateNetwork: params.requestPolicy.allowPrivateNetwork,
    ssrfPolicy: params.requestPolicy.ssrfPolicy,
    dispatcherPolicy: params.requestPolicy.dispatcherPolicy,
    auditContext: "vydra-job-status",
    isComplete: (payload) =>
      resolveVydraResponseStatus(payload) === "completed" ||
      extractVydraResultUrls(payload, params.kind).length > 0,
    getFailureMessage: (payload) => {
      const status = resolveVydraResponseStatus(payload);
      return status === "failed" || status === "error" || status === "cancelled"
        ? (resolveVydraErrorMessage(payload) ?? `Vydra job ${params.jobId} failed`)
        : undefined;
    },
  });
}

export async function resolveCompletedVydraPayload(params: {
  submitted: unknown;
  baseUrl: string;
  timeoutMs?: number;
  deadline?: ProviderOperationDeadline;
  fetchFn: typeof fetch;
  kind: VydraMediaKind;
  missingJobIdMessage: string;
  requestPolicy: VydraRequestPolicy;
}): Promise<unknown> {
  if (
    resolveVydraResponseStatus(params.submitted) === "completed" ||
    extractVydraResultUrls(params.submitted, params.kind).length > 0
  ) {
    return params.submitted;
  }
  const jobId = resolveVydraResponseJobId(params.submitted);
  if (!jobId) {
    throw new Error(resolveVydraErrorMessage(params.submitted) ?? params.missingJobIdMessage);
  }
  return waitForVydraJob({
    baseUrl: params.baseUrl,
    jobId,
    timeoutMs: params.timeoutMs,
    ...(params.deadline ? { deadline: params.deadline } : {}),
    fetchFn: params.fetchFn,
    kind: params.kind,
    requestPolicy: params.requestPolicy,
  });
}
