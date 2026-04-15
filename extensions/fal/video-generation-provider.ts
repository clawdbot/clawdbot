import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import {
  fetchWithSsrFGuard,
  type SsrFPolicy,
  ssrfPolicyFromDangerouslyAllowPrivateNetwork,
} from "openclaw/plugin-sdk/ssrf-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationRequest,
} from "openclaw/plugin-sdk/video-generation";

const DEFAULT_FAL_BASE_URL = "https://fal.run";
const DEFAULT_FAL_QUEUE_BASE_URL = "https://queue.fal.run";
const DEFAULT_FAL_VIDEO_MODEL = "fal-ai/minimax/video-01-live";
const HEYGEN_VIDEO_AGENT_MODEL = "fal-ai/heygen/v2/video-agent";
const SEEDANCE_2_VIDEO_MODELS = [
  "bytedance/seedance-2.0/fast/text-to-video",
  "bytedance/seedance-2.0/fast/image-to-video",
  "bytedance/seedance-2.0/text-to-video",
  "bytedance/seedance-2.0/image-to-video",
] as const;
const SEEDANCE_2_DURATION_SECONDS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;
const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 600_000;
const POLL_INTERVAL_MS = 5_000;

type FalVideoResponse = {
  video?: {
    url?: string;
    content_type?: string;
  };
  videos?: Array<{
    url?: string;
    content_type?: string;
  }>;
  prompt?: string;
  seed?: number;
};

type FalQueueResponse = {
  status?: string;
  request_id?: string;
  response_url?: string;
  status_url?: string;
  cancel_url?: string;
  detail?: string;
  response?: FalVideoResponse;
  prompt?: string;
  error?: {
    message?: string;
  };
};

let falFetchGuard = fetchWithSsrFGuard;

export function _setFalVideoFetchGuardForTesting(impl: typeof fetchWithSsrFGuard | null): void {
  falFetchGuard = impl ?? fetchWithSsrFGuard;
}

function toDataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function buildPolicy(allowPrivateNetwork: boolean): SsrFPolicy | undefined {
  return allowPrivateNetwork ? ssrfPolicyFromDangerouslyAllowPrivateNetwork(true) : undefined;
}

function extractFalVideoEntry(payload: FalVideoResponse) {
  if (normalizeOptionalString(payload.video?.url)) {
    return payload.video;
  }
  return payload.videos?.find((entry) => normalizeOptionalString(entry.url));
}

async function downloadFalVideo(
  url: string,
  policy: SsrFPolicy | undefined,
): Promise<GeneratedVideoAsset> {
  const { response, release } = await falFetchGuard({
    url,
    timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
    policy,
    auditContext: "fal-video-download",
  });
  try {
    await assertOkOrThrowHttpError(response, "fal generated video download failed");
    const mimeType = normalizeOptionalString(response.headers.get("content-type")) ?? "video/mp4";
    const arrayBuffer = await response.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      mimeType,
      fileName: `video-1.${mimeType.includes("webm") ? "webm" : "mp4"}`,
    };
  } finally {
    await release();
  }
}

function resolveFalQueueBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    if (url.hostname === "fal.run") {
      url.hostname = "queue.fal.run";
      return url.toString().replace(/\/$/, "");
    }
    return baseUrl.replace(/\/$/, "");
  } catch {
    return DEFAULT_FAL_QUEUE_BASE_URL;
  }
}

function isFalMiniMaxLiveModel(model: string): boolean {
  return normalizeLowercaseStringOrEmpty(model) === DEFAULT_FAL_VIDEO_MODEL;
}

function isFalSeedance2Model(model: string): boolean {
  return SEEDANCE_2_VIDEO_MODELS.includes(model as (typeof SEEDANCE_2_VIDEO_MODELS)[number]);
}

function isFalHeyGenVideoAgentModel(model: string): boolean {
  return normalizeLowercaseStringOrEmpty(model) === HEYGEN_VIDEO_AGENT_MODEL;
}

function resolveFalResolution(resolution: VideoGenerationRequest["resolution"], model: string) {
  if (!resolution) {
    return undefined;
  }
  if (isFalSeedance2Model(model)) {
    return resolution.toLowerCase();
  }
  return resolution;
}

function resolveFalDuration(
  durationSeconds: number | undefined,
  model: string,
): number | string | undefined {
  if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds)) {
    return undefined;
  }
  const duration = Math.max(1, Math.round(durationSeconds));
  if (isFalSeedance2Model(model)) {
    return String(duration);
  }
  return duration;
}

function buildFalVideoRequestBody(params: {
  req: VideoGenerationRequest;
  model: string;
}): Record<string, unknown> {
  const requestBody: Record<string, unknown> = {
    prompt: params.req.prompt,
  };
  const input = params.req.inputImages?.[0];
  if (input) {
    requestBody.image_url = normalizeOptionalString(input.url)
      ? normalizeOptionalString(input.url)
      : input.buffer
        ? toDataUrl(input.buffer, normalizeOptionalString(input.mimeType) ?? "image/png")
        : undefined;
  }
  // MiniMax Live on fal currently documents prompt + optional image_url only.
  // Keep the default model conservative so queue requests do not hang behind
  // unsupported knobs such as duration/resolution/aspect-ratio overrides.
  if (isFalMiniMaxLiveModel(params.model) || isFalHeyGenVideoAgentModel(params.model)) {
    return requestBody;
  }
  const aspectRatio = normalizeOptionalString(params.req.aspectRatio);
  if (aspectRatio) {
    requestBody.aspect_ratio = aspectRatio;
  }
  const size = normalizeOptionalString(params.req.size);
  if (size) {
    requestBody.size = size;
  }
  const resolution = resolveFalResolution(params.req.resolution, params.model);
  if (resolution) {
    requestBody.resolution = resolution;
  }
  const duration = resolveFalDuration(params.req.durationSeconds, params.model);
  if (duration) {
    requestBody.duration = duration;
  }
  if (isFalSeedance2Model(params.model) && typeof params.req.audio === "boolean") {
    requestBody.generate_audio = params.req.audio;
  }
  return requestBody;
}

async function fetchFalJson(params: {
  url: string;
  init?: RequestInit;
  timeoutMs: number;
  policy: SsrFPolicy | undefined;
  dispatcherPolicy: Parameters<typeof fetchWithSsrFGuard>[0]["dispatcherPolicy"];
  auditContext: string;
  errorContext: string;
}): Promise<unknown> {
  const { response, release } = await falFetchGuard({
    url: params.url,
    init: params.init,
    timeoutMs: params.timeoutMs,
    policy: params.policy,
    dispatcherPolicy: params.dispatcherPolicy,
    auditContext: params.auditContext,
  });
  try {
    await assertOkOrThrowHttpError(response, params.errorContext);
    return await response.json();
  } finally {
    await release();
  }
}

async function waitForFalQueueResult(params: {
  statusUrl: string;
  responseUrl: string;
  headers: Headers;
  timeoutMs: number;
  policy: SsrFPolicy | undefined;
  dispatcherPolicy: Parameters<typeof fetchWithSsrFGuard>[0]["dispatcherPolicy"];
}): Promise<FalQueueResponse> {
  const deadline = Date.now() + params.timeoutMs;
  let lastStatus = "unknown";
  while (Date.now() < deadline) {
    const payload = (await fetchFalJson({
      url: params.statusUrl,
      init: {
        method: "GET",
        headers: params.headers,
      },
      timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
      policy: params.policy,
      dispatcherPolicy: params.dispatcherPolicy,
      auditContext: "fal-video-status",
      errorContext: "fal video status request failed",
    })) as FalQueueResponse;
    const status = normalizeOptionalString(payload.status)?.toUpperCase();
    if (status) {
      lastStatus = status;
    }
    if (status === "COMPLETED") {
      return (await fetchFalJson({
        url: params.responseUrl,
        init: {
          method: "GET",
          headers: params.headers,
        },
        timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
        policy: params.policy,
        dispatcherPolicy: params.dispatcherPolicy,
        auditContext: "fal-video-result",
        errorContext: "fal video result request failed",
      })) as FalQueueResponse;
    }
    if (status === "FAILED" || status === "CANCELLED") {
      throw new Error(
        normalizeOptionalString(payload.detail) ||
          normalizeOptionalString(payload.error?.message) ||
          `fal video generation ${normalizeLowercaseStringOrEmpty(status)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`fal video generation did not finish in time (last status: ${lastStatus})`);
}

function extractFalVideoPayload(payload: FalQueueResponse): FalVideoResponse {
  if (payload.response && typeof payload.response === "object") {
    return payload.response;
  }
  return payload as FalVideoResponse;
}

export function buildFalVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: "fal",
    label: "fal",
    defaultModel: DEFAULT_FAL_VIDEO_MODEL,
    models: [
      DEFAULT_FAL_VIDEO_MODEL,
      HEYGEN_VIDEO_AGENT_MODEL,
      ...SEEDANCE_2_VIDEO_MODELS,
      "fal-ai/kling-video/v2.1/master/text-to-video",
      "fal-ai/wan/v2.2-a14b/text-to-video",
      "fal-ai/wan/v2.2-a14b/image-to-video",
    ],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "fal",
        agentDir,
      }),
    capabilities: {
      generate: {
        maxVideos: 1,
        supportedDurationSecondsByModel: Object.fromEntries(
          SEEDANCE_2_VIDEO_MODELS.map((model) => [model, SEEDANCE_2_DURATION_SECONDS]),
        ),
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsSize: true,
        supportsAudio: true,
      },
      imageToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputImages: 1,
        supportedDurationSecondsByModel: Object.fromEntries(
          SEEDANCE_2_VIDEO_MODELS.map((model) => [model, SEEDANCE_2_DURATION_SECONDS]),
        ),
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsSize: true,
        supportsAudio: true,
      },
      videoToVideo: {
        enabled: false,
      },
    },
    async generateVideo(req) {
      if ((req.inputVideos?.length ?? 0) > 0) {
        throw new Error("fal video generation does not support video reference inputs.");
      }
      if ((req.inputImages?.length ?? 0) > 1) {
        throw new Error("fal video generation supports at most one image reference.");
      }
      const auth = await resolveApiKeyForProvider({
        provider: "fal",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("fal API key missing");
      }
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: normalizeOptionalString(req.cfg?.models?.providers?.fal?.baseUrl),
          defaultBaseUrl: DEFAULT_FAL_BASE_URL,
          allowPrivateNetwork: false,
          defaultHeaders: {
            Authorization: `Key ${auth.apiKey}`,
            "Content-Type": "application/json",
          },
          provider: "fal",
          capability: "video",
          transport: "http",
        });
      const model = normalizeOptionalString(req.model) || DEFAULT_FAL_VIDEO_MODEL;
      const requestBody = buildFalVideoRequestBody({ req, model });
      const policy = buildPolicy(allowPrivateNetwork);
      const queueBaseUrl = resolveFalQueueBaseUrl(baseUrl);
      const submitted = (await fetchFalJson({
        url: `${queueBaseUrl}/${model}`,
        init: {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody),
        },
        timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
        policy,
        dispatcherPolicy,
        auditContext: "fal-video-submit",
        errorContext: "fal video generation failed",
      })) as FalQueueResponse;
      const statusUrl = normalizeOptionalString(submitted.status_url);
      const responseUrl = normalizeOptionalString(submitted.response_url);
      if (!statusUrl || !responseUrl) {
        throw new Error("fal video generation response missing queue URLs");
      }
      const payload = await waitForFalQueueResult({
        statusUrl,
        responseUrl,
        headers,
        timeoutMs: req.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
        policy,
        dispatcherPolicy,
      });
      const videoPayload = extractFalVideoPayload(payload);
      const entry = extractFalVideoEntry(videoPayload);
      const url = normalizeOptionalString(entry?.url);
      if (!url) {
        throw new Error("fal video generation response missing output URL");
      }
      const video = await downloadFalVideo(url, policy);
      return {
        videos: [video],
        model,
        metadata: {
          ...(normalizeOptionalString(submitted.request_id)
            ? { requestId: normalizeOptionalString(submitted.request_id) }
            : {}),
          ...(videoPayload.prompt ? { prompt: videoPayload.prompt } : {}),
          ...(typeof videoPayload.seed === "number" ? { seed: videoPayload.seed } : {}),
        },
      };
    },
  };
}
