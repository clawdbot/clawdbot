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
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationRequest,
  VideoGenerationResult,
  VideoGenerationSourceAsset,
} from "openclaw/plugin-sdk/video-generation";

const DEFAULT_RUNWAY_BASE_URL = "https://api.dev.runwayml.com";
const DEFAULT_RUNWAY_MODEL = "gen4.5";
const RUNWAY_API_VERSION = "2024-11-06";
const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 120;
const MAX_DURATION_SECONDS = 10;

type RunwayTaskStatus = "PENDING" | "RUNNING" | "THROTTLED" | "SUCCEEDED" | "FAILED" | "CANCELLED";

type RunwayTaskCreateResponse = {
  id?: string;
};

type RunwayTaskDetailResponse = {
  id?: string;
  status?: RunwayTaskStatus;
  output?: string[];
  failure?: string | { message?: string } | null;
};

type RunwaySourceAsset = Pick<VideoGenerationSourceAsset, "buffer" | "mimeType" | "url">;

const TEXT_ONLY_MODELS = new Set(["gen4.5", "veo3.1", "veo3.1_fast", "veo3"]);
const IMAGE_MODELS = new Set([
  "gen4.5",
  "gen4_turbo",
  "gen3a_turbo",
  "veo3.1",
  "veo3.1_fast",
  "veo3",
]);
const VIDEO_MODELS = new Set(["gen4_aleph"]);
const RUNWAY_TEXT_ASPECT_RATIOS = ["16:9", "9:16"] as const;
const RUNWAY_EDIT_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "3:4", "4:3", "21:9"] as const;

function resolveRunwayBaseUrl(req: VideoGenerationRequest): string {
  return (
    normalizeOptionalString(req.cfg?.models?.providers?.runway?.baseUrl) ?? DEFAULT_RUNWAY_BASE_URL
  );
}

function toDataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function resolveSourceUri(
  asset: RunwaySourceAsset | undefined,
  fallbackMimeType: string,
): string | undefined {
  if (!asset) {
    return undefined;
  }
  const url = normalizeOptionalString(asset.url);
  if (url) {
    return url;
  }
  if (!asset.buffer) {
    return undefined;
  }
  return toDataUrl(asset.buffer, normalizeOptionalString(asset.mimeType) ?? fallbackMimeType);
}

function resolveDurationSeconds(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 5;
  }
  return Math.max(2, Math.min(MAX_DURATION_SECONDS, Math.round(value)));
}

function resolveRunwayRatio(req: VideoGenerationRequest): string {
  const hasImageInput = (req.inputImages?.length ?? 0) > 0;
  const requested =
    normalizeOptionalString(req.size) ||
    (() => {
      switch (normalizeOptionalString(req.aspectRatio)) {
        case "9:16":
          return "720:1280";
        case "16:9":
          return "1280:720";
        case "1:1":
          return "960:960";
        case "3:4":
          return "832:1104";
        case "4:3":
          return "1104:832";
        case "21:9":
          return "1584:672";
        default:
          return undefined;
      }
    })();
  if (requested) {
    if (!hasImageInput && requested !== "1280:720" && requested !== "720:1280") {
      throw new Error("Runway text-to-video currently supports only 16:9 or 9:16 output ratios.");
    }
    return requested;
  }
  return "1280:720";
}

function resolveEndpoint(
  req: VideoGenerationRequest,
): "/v1/text_to_video" | "/v1/image_to_video" | "/v1/video_to_video" {
  const imageCount = req.inputImages?.length ?? 0;
  const videoCount = req.inputVideos?.length ?? 0;
  if (imageCount > 0 && videoCount > 0) {
    throw new Error("Runway video generation does not support image and video inputs together.");
  }
  if (imageCount > 1 || videoCount > 1) {
    throw new Error("Runway video generation supports at most one input image or one input video.");
  }
  if (videoCount > 0) {
    return "/v1/video_to_video";
  }
  if (imageCount > 0) {
    return "/v1/image_to_video";
  }
  return "/v1/text_to_video";
}

function buildCreateBody(req: VideoGenerationRequest): Record<string, unknown> {
  const endpoint = resolveEndpoint(req);
  const duration = resolveDurationSeconds(req.durationSeconds);
  const ratio = resolveRunwayRatio(req);
  const model = normalizeOptionalString(req.model) ?? DEFAULT_RUNWAY_MODEL;
  if (endpoint === "/v1/text_to_video") {
    if (!TEXT_ONLY_MODELS.has(model)) {
      throw new Error(
        `Runway text-to-video does not support model ${model}. Use one of: ${[...TEXT_ONLY_MODELS].join(", ")}.`,
      );
    }
    return {
      model,
      promptText: req.prompt,
      ratio,
      duration,
    };
  }

  if (endpoint === "/v1/image_to_video") {
    if (!IMAGE_MODELS.has(model)) {
      throw new Error(
        `Runway image-to-video does not support model ${model}. Use one of: ${[...IMAGE_MODELS].join(", ")}.`,
      );
    }
    const promptImage = resolveSourceUri(req.inputImages?.[0], "image/png");
    if (!promptImage) {
      throw new Error("Runway image-to-video input is missing image data.");
    }
    return {
      model,
      promptText: req.prompt,
      promptImage,
      ratio,
      duration,
    };
  }

  if (!VIDEO_MODELS.has(model)) {
    throw new Error("Runway video-to-video currently requires model gen4_aleph.");
  }
  const videoUri = resolveSourceUri(req.inputVideos?.[0], "video/mp4");
  if (!videoUri) {
    throw new Error("Runway video-to-video input is missing video data.");
  }
  return {
    model,
    promptText: req.prompt,
    videoUri,
    ratio,
  };
}

async function pollRunwayTask(params: {
  taskId: string;
  headers: Headers;
  timeoutMs?: number;
  baseUrl: string;
  fetchFn: typeof fetch;
}): Promise<RunwayTaskDetailResponse> {
  const deadline = createProviderOperationDeadline({
    timeoutMs: params.timeoutMs,
    label: `Runway video generation task ${params.taskId}`,
  });
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    const response = await fetchWithTimeout(
      `${params.baseUrl}/v1/tasks/${params.taskId}`,
      {
        method: "GET",
        headers: params.headers,
      },
      resolveProviderOperationTimeoutMs({ deadline, defaultTimeoutMs: DEFAULT_TIMEOUT_MS }),
      params.fetchFn,
    );
    await assertOkOrThrowHttpError(response, "Runway video status request failed");
    const payload = (await response.json()) as RunwayTaskDetailResponse;
    switch (payload.status) {
      case "SUCCEEDED":
        return payload;
      case "FAILED":
      case "CANCELLED":
        throw new Error(
          normalizeOptionalString(
            typeof payload.failure === "string" ? payload.failure : payload.failure?.message,
          ) || `Runway video generation ${normalizeLowercaseStringOrEmpty(payload.status)}`,
        );
      case "PENDING":
      case "RUNNING":
      case "THROTTLED":
      default:
        await waitProviderOperationPollInterval({ deadline, pollIntervalMs: POLL_INTERVAL_MS });
        break;
    }
  }
  throw new Error(`Runway video generation task ${params.taskId} did not finish in time`);
}

async function downloadRunwayVideos(params: {
  urls: string[];
  timeoutMs?: number;
  fetchFn: typeof fetch;
}): Promise<GeneratedVideoAsset[]> {
  const videos: GeneratedVideoAsset[] = [];
  for (const [index, url] of params.urls.entries()) {
    const response = await fetchWithTimeout(
      url,
      { method: "GET" },
      params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      params.fetchFn,
    );
    await assertOkOrThrowHttpError(response, "Runway generated video download failed");
    const mimeType = normalizeOptionalString(response.headers.get("content-type")) ?? "video/mp4";
    const arrayBuffer = await response.arrayBuffer();
    videos.push({
      buffer: Buffer.from(arrayBuffer),
      mimeType,
      fileName: `video-${index + 1}.${mimeType.includes("webm") ? "webm" : "mp4"}`,
      metadata: { sourceUrl: url },
    });
  }
  return videos;
}

export function buildRunwayVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: "runway",
    label: "Runway",
    defaultModel: DEFAULT_RUNWAY_MODEL,
    models: ["gen4.5", "gen4_turbo", "gen4_aleph", "gen3a_turbo", "veo3.1", "veo3.1_fast", "veo3"],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "runway",
        agentDir,
      }),
    capabilities: {
      generate: {
        maxVideos: 1,
        maxDurationSeconds: MAX_DURATION_SECONDS,
        aspectRatios: RUNWAY_TEXT_ASPECT_RATIOS,
        supportsAspectRatio: true,
      },
      imageToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputImages: 1,
        maxDurationSeconds: MAX_DURATION_SECONDS,
        aspectRatios: RUNWAY_EDIT_ASPECT_RATIOS,
        supportsAspectRatio: true,
      },
      videoToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputVideos: 1,
        aspectRatios: RUNWAY_EDIT_ASPECT_RATIOS,
        supportsAspectRatio: true,
      },
    },
    async generateVideo(req): Promise<VideoGenerationResult> {
      const auth = await resolveApiKeyForProvider({
        provider: "runway",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("Runway API key missing");
      }

      const fetchFn = fetch;
      const deadline = createProviderOperationDeadline({
        timeoutMs: req.timeoutMs,
        label: "Runway video generation",
      });
      const requestBody = buildCreateBody(req);
      const endpoint = resolveEndpoint(req);
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: resolveRunwayBaseUrl(req),
          defaultBaseUrl: DEFAULT_RUNWAY_BASE_URL,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
            "Content-Type": "application/json",
            "X-Runway-Version": RUNWAY_API_VERSION,
          },
          provider: "runway",
          capability: "video",
          transport: "http",
        });
      const { response, release } = await postJsonRequest({
        url: `${baseUrl}${endpoint}`,
        headers,
        body: requestBody,
        timeoutMs: resolveProviderOperationTimeoutMs({
          deadline,
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
        }),
        fetchFn,
        allowPrivateNetwork,
        dispatcherPolicy,
      });
      try {
        await assertOkOrThrowHttpError(response, "Runway video generation failed");
        const submitted = (await response.json()) as RunwayTaskCreateResponse;
        const taskId = normalizeOptionalString(submitted.id);
        if (!taskId) {
          throw new Error("Runway video generation response missing task id");
        }
        const completed = await pollRunwayTask({
          taskId,
          headers,
          timeoutMs: resolveProviderOperationTimeoutMs({
            deadline,
            defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
          }),
          baseUrl,
          fetchFn,
        });
        const outputUrls = completed.output
          ?.map((value) => normalizeOptionalString(value))
          .filter((value): value is string => Boolean(value));
        if (!outputUrls?.length) {
          throw new Error("Runway video generation completed without output URLs");
        }
        const videos = await downloadRunwayVideos({
          urls: outputUrls,
          timeoutMs: resolveProviderOperationTimeoutMs({
            deadline,
            defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
          }),
          fetchFn,
        });
        return {
          videos,
          model: normalizeOptionalString(req.model) ?? DEFAULT_RUNWAY_MODEL,
          metadata: {
            taskId,
            status: completed.status,
            endpoint,
            outputUrls,
          },
        };
      } finally {
        await release();
      }
    },
  };
}
