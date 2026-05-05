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
const SEEDANCE_2_TEXT_IMAGE_VIDEO_MODELS = [
  "bytedance/seedance-2.0/fast/text-to-video",
  "bytedance/seedance-2.0/fast/image-to-video",
  "bytedance/seedance-2.0/text-to-video",
  "bytedance/seedance-2.0/image-to-video",
] as const;
const SEEDANCE_2_REFERENCE_VIDEO_MODELS = [
  "bytedance/seedance-2.0/fast/reference-to-video",
  "bytedance/seedance-2.0/reference-to-video",
] as const;
const SEEDANCE_2_VIDEO_MODELS = [
  ...SEEDANCE_2_TEXT_IMAGE_VIDEO_MODELS,
  ...SEEDANCE_2_REFERENCE_VIDEO_MODELS,
] as const;
const SEEDANCE_2_DURATION_SECONDS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;
const SEEDANCE_REFERENCE_MAX_IMAGES = 9;
const SEEDANCE_REFERENCE_MAX_VIDEOS = 3;
const SEEDANCE_REFERENCE_MAX_AUDIOS = 3;
const SEEDANCE_REFERENCE_MAX_FILES = 12;
const SEEDANCE_REFERENCE_MAX_IMAGES_BY_MODEL = Object.fromEntries(
  SEEDANCE_2_REFERENCE_VIDEO_MODELS.map((model) => [model, SEEDANCE_REFERENCE_MAX_IMAGES]),
);
const SEEDANCE_REFERENCE_MAX_VIDEOS_BY_MODEL = Object.fromEntries(
  SEEDANCE_2_REFERENCE_VIDEO_MODELS.map((model) => [model, SEEDANCE_REFERENCE_MAX_VIDEOS]),
);
const SEEDANCE_REFERENCE_MAX_AUDIOS_BY_MODEL = Object.fromEntries(
  SEEDANCE_2_REFERENCE_VIDEO_MODELS.map((model) => [model, SEEDANCE_REFERENCE_MAX_AUDIOS]),
);
const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 1_200_000;
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
      url,
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

function isFalSeedance2ReferenceModel(model: string): boolean {
  return SEEDANCE_2_REFERENCE_VIDEO_MODELS.includes(
    model as (typeof SEEDANCE_2_REFERENCE_VIDEO_MODELS)[number],
  );
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

function resolveFalReferenceUrl(
  asset: NonNullable<VideoGenerationRequest["inputImages"]>[number] | undefined,
  defaultMimeType: string,
  label: string,
): string {
  const assetUrl = normalizeOptionalString(asset?.url);
  if (assetUrl) {
    return assetUrl;
  }
  if (!asset?.buffer) {
    throw new Error(`fal ${label} is missing media data.`);
  }
  return toDataUrl(asset.buffer, normalizeOptionalString(asset.mimeType) ?? defaultMimeType);
}

function resolveFalReferenceUrls(
  assets: VideoGenerationRequest["inputImages"],
  defaultMimeType: string,
  label: string,
): string[] {
  return (assets ?? []).map((asset) => resolveFalReferenceUrl(asset, defaultMimeType, label));
}

function applyFalSeedanceControls(params: {
  req: VideoGenerationRequest;
  model: string;
  body: Record<string, unknown>;
}): void {
  const aspectRatio = normalizeOptionalString(params.req.aspectRatio);
  if (aspectRatio) {
    params.body.aspect_ratio = aspectRatio;
  }
  const size = normalizeOptionalString(params.req.size);
  if (size) {
    params.body.size = size;
  }
  const resolution = resolveFalResolution(params.req.resolution, params.model);
  if (resolution) {
    params.body.resolution = resolution;
  }
  const duration = resolveFalDuration(params.req.durationSeconds, params.model);
  if (duration) {
    params.body.duration = duration;
  }
  if (isFalSeedance2Model(params.model) && typeof params.req.audio === "boolean") {
    params.body.generate_audio = params.req.audio;
  }
}

function buildFalVideoRequestBody(params: {
  req: VideoGenerationRequest;
  model: string;
}): Record<string, unknown> {
  const requestBody: Record<string, unknown> = {
    prompt: params.req.prompt,
  };

  if (isFalSeedance2ReferenceModel(params.model)) {
    const imageUrls = resolveFalReferenceUrls(
      params.req.inputImages,
      "image/png",
      "reference image",
    );
    const videoUrls = resolveFalReferenceUrls(
      params.req.inputVideos,
      "video/mp4",
      "reference video",
    );
    const audioUrls = resolveFalReferenceUrls(
      params.req.inputAudios,
      "audio/mpeg",
      "reference audio",
    );
    if (imageUrls.length > 0) {
      requestBody.image_urls = imageUrls;
    }
    if (videoUrls.length > 0) {
      requestBody.video_urls = videoUrls;
    }
    if (audioUrls.length > 0) {
      requestBody.audio_urls = audioUrls;
    }
    applyFalSeedanceControls({ req: params.req, model: params.model, body: requestBody });
    return requestBody;
  }

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
  applyFalSeedanceControls({ req: params.req, model: params.model, body: requestBody });
  return requestBody;
}

function validateFalVideoReferenceInputs(params: {
  req: VideoGenerationRequest;
  model: string;
}): void {
  const imageCount = params.req.inputImages?.length ?? 0;
  const videoCount = params.req.inputVideos?.length ?? 0;
  const audioCount = params.req.inputAudios?.length ?? 0;
  if (isFalSeedance2ReferenceModel(params.model)) {
    if (imageCount > SEEDANCE_REFERENCE_MAX_IMAGES) {
      throw new Error(
        `fal Seedance reference-to-video supports at most ${SEEDANCE_REFERENCE_MAX_IMAGES} reference images.`,
      );
    }
    if (videoCount > SEEDANCE_REFERENCE_MAX_VIDEOS) {
      throw new Error(
        `fal Seedance reference-to-video supports at most ${SEEDANCE_REFERENCE_MAX_VIDEOS} reference videos.`,
      );
    }
    if (audioCount > SEEDANCE_REFERENCE_MAX_AUDIOS) {
      throw new Error(
        `fal Seedance reference-to-video supports at most ${SEEDANCE_REFERENCE_MAX_AUDIOS} reference audios.`,
      );
    }
    const totalFiles = imageCount + videoCount + audioCount;
    if (totalFiles > SEEDANCE_REFERENCE_MAX_FILES) {
      throw new Error(
        `fal Seedance reference-to-video supports at most ${SEEDANCE_REFERENCE_MAX_FILES} total reference files.`,
      );
    }
    if (audioCount > 0 && imageCount === 0 && videoCount === 0) {
      throw new Error(
        "fal Seedance reference-to-video requires at least one image or video reference when audio references are provided.",
      );
    }
    return;
  }

  if (videoCount > 0) {
    throw new Error("fal video generation does not support video reference inputs.");
  }
  if (audioCount > 0) {
    throw new Error("fal video generation does not support audio reference inputs.");
  }
  if (imageCount > 1) {
    throw new Error("fal video generation supports at most one image reference.");
  }
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
        maxInputImagesByModel: SEEDANCE_REFERENCE_MAX_IMAGES_BY_MODEL,
        maxInputAudiosByModel: SEEDANCE_REFERENCE_MAX_AUDIOS_BY_MODEL,
        supportedDurationSecondsByModel: Object.fromEntries(
          SEEDANCE_2_VIDEO_MODELS.map((model) => [model, SEEDANCE_2_DURATION_SECONDS]),
        ),
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsSize: true,
        supportsAudio: true,
      },
      videoToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputImages: 0,
        maxInputImagesByModel: SEEDANCE_REFERENCE_MAX_IMAGES_BY_MODEL,
        maxInputVideos: 0,
        maxInputVideosByModel: SEEDANCE_REFERENCE_MAX_VIDEOS_BY_MODEL,
        maxInputAudiosByModel: SEEDANCE_REFERENCE_MAX_AUDIOS_BY_MODEL,
        supportedDurationSecondsByModel: Object.fromEntries(
          SEEDANCE_2_REFERENCE_VIDEO_MODELS.map((model) => [model, SEEDANCE_2_DURATION_SECONDS]),
        ),
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsSize: true,
        supportsAudio: true,
      },
    },
    async generateVideo(req) {
      const model = normalizeOptionalString(req.model) || DEFAULT_FAL_VIDEO_MODEL;
      validateFalVideoReferenceInputs({ req, model });
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
