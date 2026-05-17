import { extensionForMime } from "openclaw/plugin-sdk/media-mime";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  createProviderOperationDeadline,
  createProviderOperationTimeoutResolver,
  fetchProviderDownloadResponse,
  fetchProviderOperationResponse,
  postJsonRequest,
  resolveProviderOperationTimeoutMs,
  resolveProviderHttpRequestConfig,
  waitProviderOperationPollInterval,
  type ProviderOperationTimeoutMs,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationRequest,
} from "openclaw/plugin-sdk/video-generation";

const DEFAULT_XAI_VIDEO_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_XAI_VIDEO_MODEL = "grok-imagine-video";
const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 120;
const XAI_VIDEO_ASPECT_RATIOS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]);
const XAI_VIDEO_MALFORMED_RESPONSE = "xAI video generation response malformed";

type XaiVideoCreateResponse = {
  request_id?: string;
  error?: {
    code?: string;
    message?: string;
  } | null;
};

type XaiVideoStatusResponse = {
  request_id?: string;
  status?: "queued" | "processing" | "done" | "failed" | "expired";
  video?: {
    url?: string;
  } | null;
  error?: {
    code?: string;
    message?: string;
  } | null;
};

type VideoGenerationSourceInput = {
  url?: string;
  buffer?: Buffer;
  mimeType?: string;
  role?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function readXaiVideoJson(response: Response): Promise<Record<string, unknown>> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(XAI_VIDEO_MALFORMED_RESPONSE);
  }
  if (!isRecord(payload)) {
    throw new Error(XAI_VIDEO_MALFORMED_RESPONSE);
  }
  return payload;
}

function xaiErrorMessage(payload: Record<string, unknown>): string | undefined {
  const error = payload.error;
  if (error === undefined || error === null) {
    return undefined;
  }
  if (!isRecord(error)) {
    throw new Error(XAI_VIDEO_MALFORMED_RESPONSE);
  }
  return normalizeOptionalString(error.message);
}

function readXaiCreateResponse(payload: Record<string, unknown>): XaiVideoCreateResponse {
  return {
    request_id: normalizeOptionalString(payload.request_id),
    error: xaiErrorMessage(payload) ? { message: xaiErrorMessage(payload) } : null,
  };
}

function readXaiStatusResponse(payload: Record<string, unknown>): XaiVideoStatusResponse {
  const rawStatus = normalizeOptionalString(payload.status);
  // xAI's /v1/videos/{id} endpoint currently returns "pending" (with a progress
  // integer) for in-flight jobs. Treat it as "processing" so polling continues
  // instead of failing with XAI_VIDEO_MALFORMED_RESPONSE.
  const status =
    rawStatus === "pending" || rawStatus === "in_progress" ? "processing" : rawStatus;
  if (!status || !["queued", "processing", "done", "failed", "expired"].includes(status)) {
    throw new Error(XAI_VIDEO_MALFORMED_RESPONSE);
  }
  const video = payload.video;
  if (video !== undefined && video !== null && !isRecord(video)) {
    throw new Error(XAI_VIDEO_MALFORMED_RESPONSE);
  }
  return {
    request_id: normalizeOptionalString(payload.request_id),
    status: status as XaiVideoStatusResponse["status"],
    video: isRecord(video) ? { url: normalizeOptionalString(video.url) } : null,
    error: xaiErrorMessage(payload) ? { message: xaiErrorMessage(payload) } : null,
  };
}

function resolveXaiVideoBaseUrl(req: VideoGenerationRequest): string {
  return (
    normalizeOptionalString(req.cfg?.models?.providers?.xai?.baseUrl) ?? DEFAULT_XAI_VIDEO_BASE_URL
  );
}

function toDataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function resolveImageUrl(input: VideoGenerationSourceInput | undefined): string | undefined {
  if (!input) {
    return undefined;
  }
  const inputUrl = normalizeOptionalString(input.url);
  if (inputUrl) {
    return inputUrl;
  }
  if (!input.buffer) {
    throw new Error("xAI image-to-video input is missing image data.");
  }
  return toDataUrl(input.buffer, normalizeOptionalString(input.mimeType) ?? "image/png");
}

function resolveRequiredImageUrl(input: VideoGenerationSourceInput): string {
  const imageUrl = resolveImageUrl(input);
  if (!imageUrl) {
    throw new Error("xAI image-to-video input is missing image data.");
  }
  return imageUrl;
}

function isReferenceImage(input: VideoGenerationSourceInput): boolean {
  return normalizeOptionalString(input.role)?.toLowerCase() === "reference_image";
}

function resolveInputVideoUrl(input: VideoGenerationSourceInput | undefined): string | undefined {
  if (!input) {
    return undefined;
  }
  const url = normalizeOptionalString(input.url);
  if (url) {
    return url;
  }
  if (input.buffer) {
    throw new Error("xAI video editing currently requires a remote mp4 URL input.");
  }
  throw new Error("xAI video editing input is missing video data.");
}

function resolveDurationSeconds(params: {
  durationSeconds?: number;
  min?: number;
  max?: number;
}): number | undefined {
  if (typeof params.durationSeconds !== "number" || !Number.isFinite(params.durationSeconds)) {
    return undefined;
  }
  const rounded = Math.round(params.durationSeconds);
  return Math.max(params.min ?? 1, Math.min(params.max ?? 15, rounded));
}

function resolveAspectRatio(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed || !XAI_VIDEO_ASPECT_RATIOS.has(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function resolveResolution(value: string | undefined): "480p" | "720p" | undefined {
  if (value === "480P") {
    return "480p";
  }
  if (value === "720P" || value === "1080P") {
    return "720p";
  }
  return undefined;
}

function resolveXaiVideoMode(
  req: VideoGenerationRequest,
): "generate" | "referenceToVideo" | "edit" | "extend" {
  const hasVideoInput = (req.inputVideos?.length ?? 0) > 0;
  if (!hasVideoInput && (req.inputImages ?? []).some(isReferenceImage)) {
    return "referenceToVideo";
  }
  if (!hasVideoInput) {
    return "generate";
  }
  return typeof resolveDurationSeconds({
    durationSeconds: req.durationSeconds,
    min: 2,
    max: 10,
  }) === "number"
    ? "extend"
    : "edit";
}

function buildCreateBody(req: VideoGenerationRequest): Record<string, unknown> {
  const inputImages = req.inputImages ?? [];
  const hasReferenceImages = inputImages.some(isReferenceImage);
  if (hasReferenceImages && !inputImages.every(isReferenceImage)) {
    throw new Error(
      "xAI reference-image video generation requires every image role to be reference_image.",
    );
  }
  if (!hasReferenceImages && inputImages.length > 1) {
    throw new Error("xAI image-to-video generation supports at most one first-frame image.");
  }
  if (hasReferenceImages && inputImages.length > 7) {
    throw new Error("xAI reference-image video generation supports at most 7 reference images.");
  }
  if ((req.inputVideos?.length ?? 0) > 1) {
    throw new Error("xAI video generation supports at most one input video.");
  }
  if ((req.inputImages?.length ?? 0) > 0 && (req.inputVideos?.length ?? 0) > 0) {
    throw new Error("xAI video generation does not support image and video inputs together.");
  }

  const mode = resolveXaiVideoMode(req);
  const body: Record<string, unknown> = {
    model: normalizeOptionalString(req.model) ?? DEFAULT_XAI_VIDEO_MODEL,
    prompt: req.prompt,
  };

  if (mode === "generate") {
    const imageUrl = resolveImageUrl(req.inputImages?.[0]);
    if (imageUrl) {
      body.image = { url: imageUrl };
    }
    const duration = resolveDurationSeconds({
      durationSeconds: req.durationSeconds,
      min: 1,
      max: 15,
    });
    if (typeof duration === "number") {
      body.duration = duration;
    }
    const aspectRatio = resolveAspectRatio(req.aspectRatio);
    if (aspectRatio) {
      body.aspect_ratio = aspectRatio;
    }
    const resolution = resolveResolution(req.resolution);
    if (resolution) {
      body.resolution = resolution;
    }
    return body;
  }

  if (mode === "referenceToVideo") {
    body.reference_images = inputImages.map((image) => ({ url: resolveRequiredImageUrl(image) }));
    const duration = resolveDurationSeconds({
      durationSeconds: req.durationSeconds,
      min: 1,
      max: 10,
    });
    if (typeof duration === "number") {
      body.duration = duration;
    }
    const aspectRatio = resolveAspectRatio(req.aspectRatio);
    if (aspectRatio) {
      body.aspect_ratio = aspectRatio;
    }
    const resolution = resolveResolution(req.resolution);
    if (resolution) {
      body.resolution = resolution;
    }
    return body;
  }

  body.video = { url: resolveInputVideoUrl(req.inputVideos?.[0]) };
  if (mode === "extend") {
    const duration = resolveDurationSeconds({
      durationSeconds: req.durationSeconds,
      min: 2,
      max: 10,
    });
    if (typeof duration === "number") {
      body.duration = duration;
    }
  }
  return body;
}

function resolveCreateEndpoint(req: VideoGenerationRequest): string {
  switch (resolveXaiVideoMode(req)) {
    case "edit":
      return "/videos/edits";
    case "extend":
      return "/videos/extensions";
    case "referenceToVideo":
    case "generate":
    default:
      return "/videos/generations";
  }
}

async function pollXaiVideo(params: {
  requestId: string;
  headers: Headers;
  timeoutMs?: number;
  baseUrl: string;
  fetchFn: typeof fetch;
}): Promise<XaiVideoStatusResponse> {
  const deadline = createProviderOperationDeadline({
    timeoutMs: params.timeoutMs,
    label: `xAI video generation request ${params.requestId}`,
  });
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    const response = await fetchProviderOperationResponse({
      stage: "poll",
      url: `${params.baseUrl}/videos/${params.requestId}`,
      init: {
        method: "GET",
        headers: params.headers,
      },
      timeoutMs: createProviderOperationTimeoutResolver({
        deadline,
        defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      }),
      fetchFn: params.fetchFn,
      provider: "xai",
      requestFailedMessage: "xAI video status request failed",
    });
    const payload = readXaiStatusResponse(await readXaiVideoJson(response));
    switch (payload.status) {
      case "done":
        return payload;
      case "failed":
      case "expired":
        throw new Error(
          normalizeOptionalString(payload.error?.message) ??
            `xAI video generation ${payload.status}`,
        );
      case "queued":
      case "processing":
      default:
        await waitProviderOperationPollInterval({ deadline, pollIntervalMs: POLL_INTERVAL_MS });
        break;
    }
  }
  throw new Error(`xAI video generation task ${params.requestId} did not finish in time`);
}

async function downloadXaiVideo(params: {
  url: string;
  timeoutMs?: ProviderOperationTimeoutMs;
  fetchFn: typeof fetch;
}): Promise<GeneratedVideoAsset> {
  const response = await fetchProviderDownloadResponse({
    url: params.url,
    init: { method: "GET" },
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetchFn: params.fetchFn,
    provider: "xai",
    requestFailedMessage: "xAI generated video download failed",
  });
  const mimeType = normalizeOptionalString(response.headers.get("content-type")) ?? "video/mp4";
  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType,
    fileName: `video-1.${extensionForMime(mimeType)?.slice(1) ?? "mp4"}`,
  };
}

export function buildXaiVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: "xai",
    label: "xAI",
    defaultModel: DEFAULT_XAI_VIDEO_MODEL,
    models: [DEFAULT_XAI_VIDEO_MODEL],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "xai",
        agentDir,
      }),
    capabilities: {
      generate: {
        maxVideos: 1,
        maxDurationSeconds: 15,
        aspectRatios: [...XAI_VIDEO_ASPECT_RATIOS],
        resolutions: ["480P", "720P"],
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      imageToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputImages: 7,
        maxDurationSeconds: 15,
        aspectRatios: [...XAI_VIDEO_ASPECT_RATIOS],
        resolutions: ["480P", "720P"],
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      videoToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputVideos: 1,
        maxDurationSeconds: 15,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
    },
    async generateVideo(req) {
      const auth = await resolveApiKeyForProvider({
        provider: "xai",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("xAI API key missing");
      }

      const fetchFn = fetch;
      const deadline = createProviderOperationDeadline({
        timeoutMs: req.timeoutMs,
        label: "xAI video generation",
      });
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: resolveXaiVideoBaseUrl(req),
          defaultBaseUrl: DEFAULT_XAI_VIDEO_BASE_URL,
          allowPrivateNetwork: false,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
            "Content-Type": "application/json",
          },
          provider: "xai",
          capability: "video",
          transport: "http",
        });
      const { response, release } = await postJsonRequest({
        url: `${baseUrl}${resolveCreateEndpoint(req)}`,
        headers,
        body: buildCreateBody(req),
        timeoutMs: resolveProviderOperationTimeoutMs({
          deadline,
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
        }),
        fetchFn,
        allowPrivateNetwork,
        dispatcherPolicy,
      });
      try {
        await assertOkOrThrowHttpError(response, "xAI video generation failed");
        const submitted = readXaiCreateResponse(await readXaiVideoJson(response));
        const requestId = normalizeOptionalString(submitted.request_id);
        if (!requestId) {
          throw new Error(
            normalizeOptionalString(submitted.error?.message) ??
              "xAI video generation response missing request_id",
          );
        }
        const completed = await pollXaiVideo({
          requestId,
          headers,
          timeoutMs: resolveProviderOperationTimeoutMs({
            deadline,
            defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
          }),
          baseUrl,
          fetchFn,
        });
        const videoUrl = normalizeOptionalString(completed.video?.url);
        if (!videoUrl) {
          throw new Error(XAI_VIDEO_MALFORMED_RESPONSE);
        }
        const video = await downloadXaiVideo({
          url: videoUrl,
          timeoutMs: createProviderOperationTimeoutResolver({
            deadline,
            defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
          }),
          fetchFn,
        });
        return {
          videos: [video],
          model: normalizeOptionalString(req.model) ?? DEFAULT_XAI_VIDEO_MODEL,
          metadata: {
            requestId,
            status: completed.status,
            videoUrl,
            mode: resolveXaiVideoMode(req),
          },
        };
      } finally {
        await release();
      }
    },
  };
}
