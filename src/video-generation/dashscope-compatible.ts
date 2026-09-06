import { kindFromMime, normalizeMimeType } from "@openclaw/media-core/mime";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
// DashScope-compatible video provider adapts DashScope-style generation APIs.
import { resolveGeneratedMediaMaxBytes } from "../media/configured-max-bytes.js";
import {
  assertOkOrThrowHttpError,
  createProviderOperationDeadline,
  createProviderOperationTimeoutResolver,
  executeProviderOperationWithRetry,
  fetchWithTimeoutGuarded,
  postJsonRequest,
  readProviderBinaryResponse,
  readProviderJsonResponse,
  resolveProviderOperationTimeoutMs,
  waitProviderOperationPollInterval,
  type ProviderOperationTimeoutMs,
} from "../plugin-sdk/provider-http.js";
import type {
  GeneratedVideoAsset,
  VideoGenerationCatalogModelEntry,
  VideoGenerationProviderCapabilities,
  VideoGenerationRequest,
  VideoGenerationResult,
  VideoGenerationSourceAsset,
} from "./types.js";

// DashScope-compatible video helper for Wan-style async task APIs: submit JSON,
// poll task status, then download generated video URLs with byte limits.
export const DEFAULT_DASHSCOPE_WAN_VIDEO_MODEL = "wan2.6-t2v";
export const DASHSCOPE_WAN_VIDEO_MODELS = [
  DEFAULT_DASHSCOPE_WAN_VIDEO_MODEL,
  "wan2.6-i2v",
  "wan2.6-r2v",
  "wan2.6-r2v-flash",
  "wan2.7-r2v",
];

const DASHSCOPE_WAN_VIDEO_RESOLUTIONS = ["720P", "1080P"] as const;
const DASHSCOPE_WAN_VIDEO_ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4"] as const;
const DASHSCOPE_WAN_LONG_VIDEO_DURATIONS = [
  2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
] as const;
const DASHSCOPE_WAN_SHORT_VIDEO_DURATIONS = [2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
const DASHSCOPE_WAN_VIDEO_SIZE_BY_GEOMETRY: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  "480P": {
    "16:9": "832*480",
    "9:16": "480*832",
    "1:1": "624*624",
  },
  "720P": {
    "16:9": "1280*720",
    "9:16": "720*1280",
    "1:1": "960*960",
    "4:3": "1088*832",
    "3:4": "832*1088",
  },
  "1080P": {
    "16:9": "1920*1080",
    "9:16": "1080*1920",
    "1:1": "1440*1440",
    "4:3": "1632*1248",
    "3:4": "1248*1632",
  },
};
const DASHSCOPE_WAN_VIDEO_SIZES = DASHSCOPE_WAN_VIDEO_RESOLUTIONS.flatMap((resolution) =>
  Object.values(DASHSCOPE_WAN_VIDEO_SIZE_BY_GEOMETRY[resolution] ?? {}),
);

export const DASHSCOPE_WAN_VIDEO_CAPABILITIES = {
  generate: {
    maxVideos: 1,
    maxDurationSeconds: 15,
    supportedDurationSeconds: DASHSCOPE_WAN_LONG_VIDEO_DURATIONS,
    sizes: DASHSCOPE_WAN_VIDEO_SIZES,
    aspectRatios: DASHSCOPE_WAN_VIDEO_ASPECT_RATIOS,
    resolutions: DASHSCOPE_WAN_VIDEO_RESOLUTIONS,
    supportsSize: true,
    supportsAspectRatio: true,
    supportsResolution: true,
    supportsAudio: true,
    supportsWatermark: true,
  },
  imageToVideo: {
    enabled: true,
    maxVideos: 1,
    maxInputImages: 1,
    maxDurationSeconds: 15,
    supportedDurationSeconds: DASHSCOPE_WAN_LONG_VIDEO_DURATIONS,
    resolutions: DASHSCOPE_WAN_VIDEO_RESOLUTIONS,
    supportsSize: false,
    supportsAspectRatio: false,
    supportsResolution: true,
    supportsAudio: true,
    supportsWatermark: true,
  },
  videoToVideo: {
    enabled: true,
    maxVideos: 1,
    maxInputImages: 5,
    maxInputVideos: 3,
    maxDurationSeconds: 10,
    supportedDurationSeconds: DASHSCOPE_WAN_SHORT_VIDEO_DURATIONS,
    sizes: DASHSCOPE_WAN_VIDEO_SIZES,
    aspectRatios: DASHSCOPE_WAN_VIDEO_ASPECT_RATIOS,
    resolutions: DASHSCOPE_WAN_VIDEO_RESOLUTIONS,
    supportsSize: true,
    supportsAspectRatio: true,
    supportsResolution: true,
    supportsAudio: true,
    supportsWatermark: true,
  },
} satisfies VideoGenerationProviderCapabilities;

const disabledVideoTransform = { enabled: false } as const;
const dashscopeWanR2vCapabilities = {
  ...DASHSCOPE_WAN_VIDEO_CAPABILITIES,
  imageToVideo: {
    ...DASHSCOPE_WAN_VIDEO_CAPABILITIES.videoToVideo,
    enabled: true,
  },
};

// One model catalog drives both agent-visible modes and request-local runtime
// capability overlays, so the tool cannot advertise a mode the model rejects.
export const DASHSCOPE_WAN_VIDEO_CATALOG_BY_MODEL: Readonly<
  Record<string, VideoGenerationCatalogModelEntry>
> = {
  "wan2.6-t2v": {
    modes: ["generate"],
    capabilities: {
      generate: DASHSCOPE_WAN_VIDEO_CAPABILITIES.generate,
      imageToVideo: disabledVideoTransform,
      videoToVideo: disabledVideoTransform,
    },
  },
  "wan2.6-i2v": {
    modes: ["imageToVideo"],
    capabilities: {
      imageToVideo: DASHSCOPE_WAN_VIDEO_CAPABILITIES.imageToVideo,
      videoToVideo: disabledVideoTransform,
    },
  },
  "wan2.6-r2v": {
    modes: ["imageToVideo", "videoToVideo"],
    capabilities: dashscopeWanR2vCapabilities,
  },
  "wan2.6-r2v-flash": {
    modes: ["imageToVideo", "videoToVideo"],
    capabilities: dashscopeWanR2vCapabilities,
  },
  "wan2.7-r2v": {
    modes: ["imageToVideo", "videoToVideo"],
    capabilities: {
      ...dashscopeWanR2vCapabilities,
      imageToVideo: {
        ...dashscopeWanR2vCapabilities.imageToVideo,
        supportsAspectRatio: true,
        supportsAudio: false,
      },
      videoToVideo: {
        ...dashscopeWanR2vCapabilities.videoToVideo,
        supportsAspectRatio: true,
        supportsAudio: false,
      },
    },
  },
};

export const DEFAULT_VIDEO_GENERATION_DURATION_SECONDS = 5;
export const DEFAULT_VIDEO_GENERATION_TIMEOUT_MS = 120_000;
export const DEFAULT_VIDEO_RESOLUTION_TO_SIZE: Record<string, string> = {
  "480P": "832*480",
  "720P": "1280*720",
  "1080P": "1920*1080",
};

const DEFAULT_VIDEO_GENERATION_POLL_INTERVAL_MS = 2_500;
const DEFAULT_VIDEO_GENERATION_MAX_POLL_ATTEMPTS = 120;

export type DashscopeVideoGenerationResponse = {
  output?: {
    task_id?: string;
    task_status?: string;
    submit_time?: string;
    results?: Array<{
      video_url?: string;
      orig_prompt?: string;
      actual_prompt?: string;
    }>;
    video_url?: string;
    code?: string;
    message?: string;
  };
  request_id?: string;
  code?: string;
  message?: string;
};

type DashscopeWanVideoMode = "t2v" | "i2v" | "r2v";

function resolveDashscopeWanVideoMode(req: VideoGenerationRequest): DashscopeWanVideoMode {
  const model = req.model.trim().toLowerCase();
  if (model.includes("-i2v")) {
    return "i2v";
  }
  if (model.includes("-r2v")) {
    return "r2v";
  }
  if (model.includes("-t2v")) {
    return "t2v";
  }
  if ((req.inputVideos?.length ?? 0) > 0 || (req.inputImages?.length ?? 0) > 1) {
    return "r2v";
  }
  return (req.inputImages?.length ?? 0) === 1 ? "i2v" : "t2v";
}

function isDashscopeWan27Model(model: string): boolean {
  return model.trim().toLowerCase().startsWith("wan2.7");
}

function assertDashscopeWanVideoInputs(params: {
  providerLabel: string;
  req: VideoGenerationRequest;
  mode: DashscopeWanVideoMode;
}): void {
  const imageCount = params.req.inputImages?.length ?? 0;
  const videoCount = params.req.inputVideos?.length ?? 0;
  if (params.mode === "t2v" && imageCount + videoCount > 0) {
    throw new Error(
      `${params.providerLabel} model ${params.req.model} is text-to-video and does not accept reference media; use an i2v or r2v Wan model.`,
    );
  }
  if (params.mode === "i2v" && (imageCount !== 1 || videoCount > 0)) {
    throw new Error(
      `${params.providerLabel} model ${params.req.model} requires exactly one reference image and no reference videos.`,
    );
  }
  if (params.mode === "r2v") {
    const total = imageCount + videoCount;
    if (total === 0 || total > 5 || videoCount > 3) {
      throw new Error(
        `${params.providerLabel} model ${params.req.model} requires 1-5 reference images/videos, with at most 3 videos.`,
      );
    }
  }
}

export function buildDashscopeVideoGenerationInput(params: {
  providerLabel: string;
  req: VideoGenerationRequest;
}): Record<string, unknown> {
  const unsupported = [...(params.req.inputImages ?? []), ...(params.req.inputVideos ?? [])].some(
    (asset) => !asset.url?.trim(),
  );
  // DashScope accepts remote references in this path; buffer uploads require a
  // different provider-specific flow, so fail before silently dropping refs.
  if (unsupported) {
    throw new Error(
      `${params.providerLabel} video generation currently requires remote http(s) URLs for reference images/videos.`,
    );
  }
  const input: Record<string, unknown> = {
    prompt: params.req.prompt,
  };
  const mode = resolveDashscopeWanVideoMode(params.req);
  assertDashscopeWanVideoInputs({ ...params, mode });
  const referenceUrls = resolveVideoGenerationReferenceUrls(
    params.req.inputImages,
    params.req.inputVideos,
  );
  if (mode === "i2v") {
    input.img_url = referenceUrls[0];
  } else if (mode === "r2v" && isDashscopeWan27Model(params.req.model)) {
    input.media = [
      ...(params.req.inputImages ?? []).map((asset) => ({
        type: asset.role?.trim() || "reference_image",
        url: asset.url?.trim() ?? "",
      })),
      ...(params.req.inputVideos ?? []).map((asset) => ({
        type: asset.role?.trim() || "reference_video",
        url: asset.url?.trim() ?? "",
      })),
    ];
  } else if (mode === "r2v") {
    input.reference_urls = referenceUrls;
  }
  return input;
}

export function resolveVideoGenerationReferenceUrls(
  inputImages: VideoGenerationSourceAsset[] | undefined,
  inputVideos: VideoGenerationSourceAsset[] | undefined,
): string[] {
  return [...(inputImages ?? []), ...(inputVideos ?? [])]
    .map((asset) => asset.url?.trim())
    .filter((value): value is string => Boolean(value));
}

export function buildDashscopeVideoGenerationParameters(
  req: VideoGenerationRequest,
  resolutionToSize: Record<string, string> = DEFAULT_VIDEO_RESOLUTION_TO_SIZE,
): Record<string, unknown> | undefined {
  const parameters: Record<string, unknown> = {};
  const mode = resolveDashscopeWanVideoMode(req);
  const wan27 = isDashscopeWan27Model(req.model);
  const requestedSize = req.size?.trim();
  const sizeGeometry = requestedSize
    ? resolveDashscopeWanVideoSizeGeometry(requestedSize)
    : undefined;
  // Wan 2.6 I2V and all Wan 2.7 models use resolution tiers. Wan 2.6 T2V/R2V
  // use exact dimensions in `size`; folding these together causes API rejection.
  if (wan27 || mode === "i2v") {
    const resolution = req.resolution?.trim() || sizeGeometry?.resolution;
    if (resolution) {
      parameters.resolution = resolution;
    }
    if (wan27 && mode !== "i2v") {
      const ratio = req.aspectRatio?.trim() || sizeGeometry?.aspectRatio;
      if (ratio) {
        parameters.ratio = ratio;
      }
    }
  } else {
    const ratio = req.aspectRatio?.trim() || "16:9";
    const size =
      requestedSize ||
      (req.resolution
        ? (DASHSCOPE_WAN_VIDEO_SIZE_BY_GEOMETRY[req.resolution]?.[ratio] ??
          resolutionToSize[req.resolution])
        : undefined);
    if (size) {
      parameters.size = size;
    }
  }
  if (typeof req.durationSeconds === "number" && Number.isFinite(req.durationSeconds)) {
    parameters.duration = Math.max(1, Math.round(req.durationSeconds));
  }
  if (typeof req.audio === "boolean" && !wan27) {
    parameters.audio = req.audio;
  }
  if (typeof req.watermark === "boolean") {
    parameters.watermark = req.watermark;
  }
  return Object.keys(parameters).length > 0 ? parameters : undefined;
}

function resolveDashscopeWanVideoSizeGeometry(
  size: string,
): { resolution: string; aspectRatio: string } | undefined {
  const normalizedSize = size.trim().toLowerCase().replace("x", "*");
  for (const [resolution, sizes] of Object.entries(DASHSCOPE_WAN_VIDEO_SIZE_BY_GEOMETRY)) {
    for (const [aspectRatio, candidate] of Object.entries(sizes)) {
      if (candidate.toLowerCase() === normalizedSize) {
        return { resolution, aspectRatio };
      }
    }
  }
  return undefined;
}

// DashScope may return videos in results[] or a top-level output.video_url.
// De-dupe so downstream downloads produce one asset per unique URL.
export function extractDashscopeVideoUrls(payload: DashscopeVideoGenerationResponse): string[] {
  const urls = [
    ...(payload.output?.results?.map((entry) => entry.video_url).filter(Boolean) ?? []),
    payload.output?.video_url,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return uniqueStrings(urls);
}

export async function pollDashscopeVideoTaskUntilComplete(params: {
  providerLabel: string;
  taskId: string;
  headers: Headers;
  timeoutMs?: number;
  fetchFn: typeof fetch;
  baseUrl: string;
  allowPrivateNetwork?: boolean;
  dispatcherPolicy?: Parameters<typeof postJsonRequest>[0]["dispatcherPolicy"];
  defaultTimeoutMs?: number;
}): Promise<DashscopeVideoGenerationResponse> {
  const defaultTimeoutMs = params.defaultTimeoutMs ?? DEFAULT_VIDEO_GENERATION_TIMEOUT_MS;
  const deadline = createProviderOperationDeadline({
    timeoutMs: params.timeoutMs,
    label: `${params.providerLabel} video generation task ${params.taskId}`,
  });
  for (let attempt = 0; attempt < DEFAULT_VIDEO_GENERATION_MAX_POLL_ATTEMPTS; attempt += 1) {
    const pollResult = await executeProviderOperationWithRetry({
      provider: params.providerLabel,
      stage: "poll",
      operation: async () => {
        const result = await fetchWithTimeoutGuarded(
          `${params.baseUrl}/api/v1/tasks/${params.taskId}`,
          {
            method: "GET",
            headers: params.headers,
          },
          createProviderOperationTimeoutResolver({ deadline, defaultTimeoutMs })(),
          params.fetchFn,
          {
            ...(params.allowPrivateNetwork ? { ssrfPolicy: { allowPrivateNetwork: true } } : {}),
            ...(params.dispatcherPolicy ? { dispatcherPolicy: params.dispatcherPolicy } : {}),
          },
        );
        try {
          await assertOkOrThrowHttpError(
            result.response,
            `${params.providerLabel} video-generation task poll failed`,
          );
          return result;
        } catch (error) {
          await result.release();
          throw error;
        }
      },
    });
    let payload: DashscopeVideoGenerationResponse;
    try {
      payload = await readProviderJsonResponse<DashscopeVideoGenerationResponse>(
        pollResult.response,
        `${params.providerLabel} video-generation task poll`,
      );
    } finally {
      await pollResult.release();
    }
    const status = payload.output?.task_status?.trim().toUpperCase();
    if (status === "SUCCEEDED") {
      return payload;
    }
    // DashScope reports missing or expired task IDs as UNKNOWN, not PENDING;
    // waiting cannot recover them and hides the actionable provider outcome.
    if (status === "UNKNOWN") {
      const reason = payload.output?.message?.trim() || payload.message?.trim();
      throw new Error(
        `${params.providerLabel} video generation task ${params.taskId} is unknown or expired${
          reason ? `: ${reason}` : ""
        }`,
      );
    }
    // Terminal failure statuses carry provider messages; nonterminal statuses
    // continue until the shared operation deadline or max poll attempts wins.
    if (status === "FAILED" || status === "CANCELED") {
      throw new Error(
        payload.output?.message?.trim() ||
          payload.message?.trim() ||
          `${params.providerLabel} video generation task ${params.taskId} ${normalizeLowercaseStringOrEmpty(status)}`,
      );
    }
    await waitProviderOperationPollInterval({
      deadline,
      pollIntervalMs: DEFAULT_VIDEO_GENERATION_POLL_INTERVAL_MS,
    });
  }
  throw new Error(
    `${params.providerLabel} video generation task ${params.taskId} did not finish in time`,
  );
}

export async function runDashscopeVideoGenerationTask(params: {
  providerLabel: string;
  model: string;
  req: VideoGenerationRequest;
  url: string;
  headers: Headers;
  baseUrl: string;
  timeoutMs?: number;
  fetchFn: typeof fetch;
  allowPrivateNetwork?: boolean;
  dispatcherPolicy?: Parameters<typeof postJsonRequest>[0]["dispatcherPolicy"];
  defaultTimeoutMs?: number;
}): Promise<VideoGenerationResult> {
  const defaultTimeoutMs = params.defaultTimeoutMs ?? DEFAULT_VIDEO_GENERATION_TIMEOUT_MS;
  const deadline = createProviderOperationDeadline({
    timeoutMs: params.timeoutMs,
    label: `${params.providerLabel} video generation`,
  });
  const { response, release } = await postJsonRequest({
    url: params.url,
    headers: params.headers,
    body: {
      model: params.model,
      input: buildDashscopeVideoGenerationInput({
        providerLabel: params.providerLabel,
        req: params.req,
      }),
      parameters: buildDashscopeVideoGenerationParameters(
        {
          ...params.req,
          durationSeconds: params.req.durationSeconds ?? DEFAULT_VIDEO_GENERATION_DURATION_SECONDS,
        },
        DEFAULT_VIDEO_RESOLUTION_TO_SIZE,
      ),
    },
    timeoutMs: resolveProviderOperationTimeoutMs({ deadline, defaultTimeoutMs }),
    fetchFn: params.fetchFn,
    allowPrivateNetwork: params.allowPrivateNetwork,
    dispatcherPolicy: params.dispatcherPolicy,
  });

  let submitted: DashscopeVideoGenerationResponse;
  try {
    await assertOkOrThrowHttpError(response, `${params.providerLabel} video generation failed`);
    submitted = await readProviderJsonResponse<DashscopeVideoGenerationResponse>(
      response,
      `${params.providerLabel} video generation`,
    );
  } finally {
    await release();
  }

  const taskId = submitted.output?.task_id?.trim();
  if (!taskId) {
    throw new Error(`${params.providerLabel} video generation response missing task_id`);
  }
  const completed = await pollDashscopeVideoTaskUntilComplete({
    providerLabel: params.providerLabel,
    taskId,
    headers: params.headers,
    timeoutMs: resolveProviderOperationTimeoutMs({ deadline, defaultTimeoutMs }),
    fetchFn: params.fetchFn,
    baseUrl: params.baseUrl,
    allowPrivateNetwork: params.allowPrivateNetwork,
    dispatcherPolicy: params.dispatcherPolicy,
    defaultTimeoutMs,
  });
  const urls = extractDashscopeVideoUrls(completed);
  if (urls.length === 0) {
    throw new Error(`${params.providerLabel} video generation completed without output video URLs`);
  }
  const videos = await downloadDashscopeGeneratedVideos({
    providerLabel: params.providerLabel,
    urls,
    timeoutMs: createProviderOperationTimeoutResolver({ deadline, defaultTimeoutMs }),
    fetchFn: params.fetchFn,
    allowPrivateNetwork: params.allowPrivateNetwork,
    dispatcherPolicy: params.dispatcherPolicy,
    defaultTimeoutMs,
    maxBytes: resolveGeneratedMediaMaxBytes(params.req.cfg, "video"),
  });
  return {
    videos,
    model: params.model,
    metadata: {
      requestId: submitted.request_id,
      taskId,
      taskStatus: completed.output?.task_status,
    },
  };
}

function resolveDashscopeVideoDownloadTimeoutMs(
  providerLabel: string,
  timeoutMs: ProviderOperationTimeoutMs | undefined,
  defaultTimeoutMs: number | undefined,
): number {
  const resolved = typeof timeoutMs === "function" ? timeoutMs() : timeoutMs;
  const downloadTimeoutMs =
    typeof resolved === "number" && Number.isFinite(resolved)
      ? Math.max(0, Math.floor(resolved))
      : (defaultTimeoutMs ?? DEFAULT_VIDEO_GENERATION_TIMEOUT_MS);
  if (downloadTimeoutMs <= 0) {
    throw new Error(
      `${providerLabel} generated video download stalled: remaining budget exhausted`,
    );
  }
  return downloadTimeoutMs;
}

// Downloads task result URLs into generated video assets. The byte limit comes
// from OpenClaw media config so provider URLs cannot overfill memory.
export async function downloadDashscopeGeneratedVideos(params: {
  providerLabel: string;
  urls: string[];
  timeoutMs?: ProviderOperationTimeoutMs;
  fetchFn: typeof fetch;
  allowPrivateNetwork?: boolean;
  dispatcherPolicy?: Parameters<typeof postJsonRequest>[0]["dispatcherPolicy"];
  defaultTimeoutMs?: number;
  maxBytes: number;
}): Promise<GeneratedVideoAsset[]> {
  const videos: GeneratedVideoAsset[] = [];
  const downloadLabel = `${params.providerLabel} generated video download`;
  for (const [index, url] of params.urls.entries()) {
    const result = await executeProviderOperationWithRetry({
      provider: params.providerLabel,
      stage: "download",
      operation: async () => {
        const downloadTimeoutMs = resolveDashscopeVideoDownloadTimeoutMs(
          params.providerLabel,
          params.timeoutMs,
          params.defaultTimeoutMs,
        );
        const guarded = await fetchWithTimeoutGuarded(
          url,
          { method: "GET" },
          downloadTimeoutMs,
          params.fetchFn,
          {
            ...(params.allowPrivateNetwork ? { ssrfPolicy: { allowPrivateNetwork: true } } : {}),
            ...(params.dispatcherPolicy ? { dispatcherPolicy: params.dispatcherPolicy } : {}),
          },
        );
        try {
          await assertOkOrThrowHttpError(
            guarded.response,
            `${params.providerLabel} generated video download failed`,
          );
          return guarded;
        } catch (error) {
          await guarded.release();
          throw error;
        }
      },
    });
    let buffer: Buffer;
    let mimeType: string;
    try {
      try {
        const contentType = normalizeMimeType(result.response.headers.get("content-type"));
        if (
          contentType &&
          contentType !== "application/octet-stream" &&
          kindFromMime(contentType) !== "video"
        ) {
          throw new Error(`${downloadLabel}: malformed video response`);
        }
      } catch (error) {
        // A capture tee can retain cancellation until the guarded transport is released.
        void result.response.body?.cancel(error).catch(() => undefined);
        throw error;
      }

      // Re-resolve after headers so the body uses the remaining operation budget.
      let downloadTimeoutMs: number;
      try {
        downloadTimeoutMs = resolveDashscopeVideoDownloadTimeoutMs(
          params.providerLabel,
          params.timeoutMs,
          params.defaultTimeoutMs,
        );
      } catch (error) {
        // A capture tee must not delay releasing the expired request.
        void result.response.body?.cancel(error).catch(() => undefined);
        throw error;
      }
      buffer = await readProviderBinaryResponse(result.response, downloadLabel, "video", {
        maxBytes: params.maxBytes,
        chunkTimeoutMs: downloadTimeoutMs,
        onOverflow: ({ maxBytes }) =>
          new Error(`${params.providerLabel} generated video download exceeds ${maxBytes} bytes`),
        onIdleTimeout: ({ chunkTimeoutMs }) =>
          new Error(
            `${params.providerLabel} generated video download stalled: no data received for ${chunkTimeoutMs}ms`,
          ),
      });
      mimeType = result.response.headers.get("content-type")?.trim() || "video/mp4";
    } finally {
      await result.release();
    }
    videos.push({
      buffer,
      mimeType,
      fileName: `video-${index + 1}.mp4`,
      metadata: { sourceUrl: url },
    });
  }
  return videos;
}
