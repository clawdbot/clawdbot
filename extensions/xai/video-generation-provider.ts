import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  createProviderOperationDeadline,
  fetchWithTimeout,
  postJsonRequest,
  resolveProviderOperationTimeoutMs,
  resolveProviderHttpRequestConfig,
  waitProviderOperationPollInterval,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
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
};

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

function resolveXaiVideoMode(req: VideoGenerationRequest): "generate" | "edit" | "extend" {
  const hasVideoInput = (req.inputVideos?.length ?? 0) > 0;
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
  if ((req.inputImages?.length ?? 0) > 1) {
    throw new Error("xAI video generation supports at most one reference image.");
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
    const response = await fetchWithTimeout(
      `${params.baseUrl}/videos/${params.requestId}`,
      {
        method: "GET",
        headers: params.headers,
      },
      resolveProviderOperationTimeoutMs({ deadline, defaultTimeoutMs: DEFAULT_TIMEOUT_MS }),
      params.fetchFn,
    );
    await assertOkOrThrowHttpError(response, "xAI video status request failed");
    const payload = (await response.json()) as XaiVideoStatusResponse;
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
  timeoutMs?: number;
  fetchFn: typeof fetch;
}): Promise<GeneratedVideoAsset> {
  const response = await fetchWithTimeout(
    params.url,
    { method: "GET" },
    params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    params.fetchFn,
  );
  await assertOkOrThrowHttpError(response, "xAI generated video download failed");
  const mimeType = normalizeOptionalString(response.headers.get("content-type")) ?? "video/mp4";
  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType,
    fileName: `video-1.${mimeType.includes("webm") ? "webm" : "mp4"}`,
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
        maxInputImages: 1,
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
        const submitted = (await response.json()) as XaiVideoCreateResponse;
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
          throw new Error("xAI video generation completed without an output URL");
        }
        const video = await downloadXaiVideo({
          url: videoUrl,
          timeoutMs: resolveProviderOperationTimeoutMs({
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
