import {
  assertOkOrThrowHttpError,
  createProviderOperationDeadline,
  createProviderOperationTimeoutResolver,
  fetchProviderDownloadResponse,
  fetchProviderOperationResponse,
  postJsonRequest,
  resolveProviderOperationTimeoutMs,
  waitProviderOperationPollInterval,
  type ProviderOperationTimeoutMs,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import type {
  GeneratedVideoAsset,
  VideoGenerationProviderCapabilities,
  VideoGenerationRequest,
  VideoGenerationResult,
  VideoGenerationSourceAsset,
} from "./types.js";

export const DEFAULT_DASHSCOPE_WAN_VIDEO_MODEL = "wan2.6-t2v";
export const DASHSCOPE_WAN_VIDEO_MODELS = [
  DEFAULT_DASHSCOPE_WAN_VIDEO_MODEL,
  "wan2.6-i2v",
  "wan2.6-r2v",
  "wan2.6-r2v-flash",
  "wan2.7-r2v",
];
export const DASHSCOPE_WAN_VIDEO_CAPABILITIES = {
  generate: {
    maxVideos: 1,
    maxDurationSeconds: 10,
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
    maxDurationSeconds: 10,
    supportsSize: true,
    supportsAspectRatio: true,
    supportsResolution: true,
    supportsAudio: true,
    supportsWatermark: true,
  },
  videoToVideo: {
    enabled: true,
    maxVideos: 1,
    maxInputVideos: 4,
    maxDurationSeconds: 10,
    supportsSize: true,
    supportsAspectRatio: true,
    supportsResolution: true,
    supportsAudio: true,
    supportsWatermark: true,
  },
} satisfies VideoGenerationProviderCapabilities;

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

export function buildDashscopeVideoGenerationInput(params: {
  providerLabel: string;
  req: VideoGenerationRequest;
}): Record<string, unknown> {
  const unsupported = [...(params.req.inputImages ?? []), ...(params.req.inputVideos ?? [])].some(
    (asset) => !asset.url?.trim() && asset.buffer,
  );
  if (unsupported) {
    throw new Error(
      `${params.providerLabel} video generation currently requires remote http(s) URLs for reference images/videos.`,
    );
  }
  const input: Record<string, unknown> = {
    prompt: params.req.prompt,
  };
  const referenceUrls = resolveVideoGenerationReferenceUrls(
    params.req.inputImages,
    params.req.inputVideos,
  );
  if (
    referenceUrls.length === 1 &&
    (params.req.inputImages?.length ?? 0) === 1 &&
    !params.req.inputVideos?.length
  ) {
    input.img_url = referenceUrls[0];
  } else if (referenceUrls.length > 0) {
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
  const size = req.size?.trim() || (req.resolution ? resolutionToSize[req.resolution] : undefined);
  if (size) {
    parameters.size = size;
  }
  if (req.aspectRatio?.trim()) {
    parameters.aspect_ratio = req.aspectRatio.trim();
  }
  if (typeof req.durationSeconds === "number" && Number.isFinite(req.durationSeconds)) {
    parameters.duration = Math.max(1, Math.round(req.durationSeconds));
  }
  if (typeof req.audio === "boolean") {
    parameters.enable_audio = req.audio;
  }
  if (typeof req.watermark === "boolean") {
    parameters.watermark = req.watermark;
  }
  return Object.keys(parameters).length > 0 ? parameters : undefined;
}

export function extractDashscopeVideoUrls(payload: DashscopeVideoGenerationResponse): string[] {
  const urls = [
    ...(payload.output?.results?.map((entry) => entry.video_url).filter(Boolean) ?? []),
    payload.output?.video_url,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return [...new Set(urls)];
}

export async function pollDashscopeVideoTaskUntilComplete(params: {
  providerLabel: string;
  taskId: string;
  headers: Headers;
  timeoutMs?: number;
  fetchFn: typeof fetch;
  baseUrl: string;
  defaultTimeoutMs?: number;
}): Promise<DashscopeVideoGenerationResponse> {
  const defaultTimeoutMs = params.defaultTimeoutMs ?? DEFAULT_VIDEO_GENERATION_TIMEOUT_MS;
  const deadline = createProviderOperationDeadline({
    timeoutMs: params.timeoutMs,
    label: `${params.providerLabel} video generation task ${params.taskId}`,
  });
  for (let attempt = 0; attempt < DEFAULT_VIDEO_GENERATION_MAX_POLL_ATTEMPTS; attempt += 1) {
    const response = await fetchProviderOperationResponse({
      stage: "poll",
      url: `${params.baseUrl}/api/v1/tasks/${params.taskId}`,
      init: {
        method: "GET",
        headers: params.headers,
      },
      timeoutMs: createProviderOperationTimeoutResolver({ deadline, defaultTimeoutMs }),
      fetchFn: params.fetchFn,
      provider: params.providerLabel,
      requestFailedMessage: `${params.providerLabel} video-generation task poll failed`,
    });
    const payload = (await response.json()) as DashscopeVideoGenerationResponse;
    const status = payload.output?.task_status?.trim().toUpperCase();
    if (status === "SUCCEEDED") {
      return payload;
    }
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

  try {
    await assertOkOrThrowHttpError(response, `${params.providerLabel} video generation failed`);
    const submitted = (await response.json()) as DashscopeVideoGenerationResponse;
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
      defaultTimeoutMs,
    });
    const urls = extractDashscopeVideoUrls(completed);
    if (urls.length === 0) {
      throw new Error(
        `${params.providerLabel} video generation completed without output video URLs`,
      );
    }
    const videos = await downloadDashscopeGeneratedVideos({
      providerLabel: params.providerLabel,
      urls,
      timeoutMs: createProviderOperationTimeoutResolver({ deadline, defaultTimeoutMs }),
      fetchFn: params.fetchFn,
      defaultTimeoutMs,
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
  } finally {
    await release();
  }
}

export async function downloadDashscopeGeneratedVideos(params: {
  providerLabel: string;
  urls: string[];
  timeoutMs?: ProviderOperationTimeoutMs;
  fetchFn: typeof fetch;
  defaultTimeoutMs?: number;
}): Promise<GeneratedVideoAsset[]> {
  const videos: GeneratedVideoAsset[] = [];
  for (const [index, url] of params.urls.entries()) {
    const response = await fetchProviderDownloadResponse({
      url,
      init: { method: "GET" },
      timeoutMs: params.timeoutMs ?? params.defaultTimeoutMs ?? DEFAULT_VIDEO_GENERATION_TIMEOUT_MS,
      fetchFn: params.fetchFn,
      provider: params.providerLabel,
      requestFailedMessage: `${params.providerLabel} generated video download failed`,
    });
    const arrayBuffer = await response.arrayBuffer();
    videos.push({
      buffer: Buffer.from(arrayBuffer),
      mimeType: response.headers.get("content-type")?.trim() || "video/mp4",
      fileName: `video-${index + 1}.mp4`,
      metadata: { sourceUrl: url },
    });
  }
  return videos;
}
