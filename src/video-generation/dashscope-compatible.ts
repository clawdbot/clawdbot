import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
// DashScope-compatible video provider adapts DashScope-style generation APIs.
import { readResponseWithLimit } from "../infra/http-body.js";
import { resolveGeneratedMediaMaxBytes } from "../media/configured-max-bytes.js";
import {
  assertOkOrThrowHttpError,
  createProviderOperationDeadline,
  createProviderOperationTimeoutResolver,
  executeProviderOperationWithRetry,
  fetchWithTimeoutGuarded,
  postJsonRequest,
  readProviderJsonResponse,
  resolveProviderOperationTimeoutMs,
  waitProviderOperationPollInterval,
  type ProviderOperationTimeoutMs,
} from "../plugin-sdk/provider-http.js";
import { buildTimeoutAbortSignal } from "../utils/fetch-timeout.js";
import type {
  GeneratedVideoAsset,
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
    timeoutMs: params.timeoutMs ?? defaultTimeoutMs,
    label: `${params.providerLabel} video generation task ${params.taskId}`,
  });
  const bodyReadOptions = createDashscopeBodyReadOptions({
    label: deadline.label,
    timeoutMs: createProviderOperationTimeoutResolver({ deadline, defaultTimeoutMs }),
    totalTimeoutMs: deadline.timeoutMs,
  });
  for (let attempt = 0; attempt < DEFAULT_VIDEO_GENERATION_MAX_POLL_ATTEMPTS; attempt += 1) {
    const pollResult = await fetchDashscopeGuardedResponse({
      providerLabel: params.providerLabel,
      stage: "poll",
      url: `${params.baseUrl}/api/v1/tasks/${params.taskId}`,
      headers: params.headers,
      timeoutMs: bodyReadOptions.timeoutMs,
      bodyReadOptions,
      failureLabel: `${params.providerLabel} video-generation task poll failed`,
      fetchFn: params.fetchFn,
      allowPrivateNetwork: params.allowPrivateNetwork,
      dispatcherPolicy: params.dispatcherPolicy,
    });
    let payload: DashscopeVideoGenerationResponse;
    try {
      payload = await readProviderJsonResponse<DashscopeVideoGenerationResponse>(
        pollResult.response,
        `${params.providerLabel} video-generation task poll`,
        bodyReadOptions,
      );
    } finally {
      await pollResult.release();
    }
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

function createDashscopeBodyReadOptions(params: {
  label: string;
  timeoutMs: () => number;
  totalTimeoutMs?: number;
}) {
  return {
    timeoutMs: params.timeoutMs,
    onTimeout: ({ timeoutMs }: { timeoutMs: number }) =>
      new Error(`${params.label} timed out after ${params.totalTimeoutMs ?? timeoutMs}ms`),
  };
}

async function fetchDashscopeGuardedResponse(params: {
  providerLabel: string;
  stage: "poll" | "download";
  url: string;
  headers?: Headers;
  timeoutMs: () => number;
  bodyReadOptions: ReturnType<typeof createDashscopeBodyReadOptions>;
  failureLabel: string;
  fetchFn: typeof fetch;
  allowPrivateNetwork?: boolean;
  dispatcherPolicy?: Parameters<typeof postJsonRequest>[0]["dispatcherPolicy"];
}) {
  const retryController = new AbortController();
  const initialTimeoutMs = params.timeoutMs();
  const { signal, cleanup } = buildTimeoutAbortSignal({
    timeoutMs: initialTimeoutMs,
    signal: retryController.signal,
    operation: `${params.providerLabel} ${params.stage}`,
    url: params.url,
  });
  let nextTimeoutMs: number | undefined = initialTimeoutMs;

  try {
    return await executeProviderOperationWithRetry({
      provider: params.providerLabel,
      stage: params.stage,
      signal,
      operation: async () => {
        let timeoutMs: number;
        try {
          timeoutMs = nextTimeoutMs ?? params.timeoutMs();
          nextTimeoutMs = undefined;
        } catch (error) {
          retryController.abort(error);
          throw error;
        }
        const guarded = await fetchWithTimeoutGuarded(
          params.url,
          {
            method: "GET",
            ...(params.headers ? { headers: params.headers } : {}),
          },
          timeoutMs,
          params.fetchFn,
          {
            ...(params.allowPrivateNetwork ? { ssrfPolicy: { allowPrivateNetwork: true } } : {}),
            ...(params.dispatcherPolicy ? { dispatcherPolicy: params.dispatcherPolicy } : {}),
          },
        );
        try {
          await assertOkOrThrowHttpError(guarded.response, params.failureLabel, {
            bodyTimeoutMs: params.bodyReadOptions.timeoutMs,
            onBodyTimeout: (timeout) => {
              const error = params.bodyReadOptions.onTimeout(timeout);
              // The same deadline also owns retry backoff; never sleep after
              // response-body timeout has exhausted the operation budget.
              retryController.abort(error);
              return error;
            },
          });
          return guarded;
        } catch (error) {
          await guarded.release();
          throw error;
        }
      },
    });
  } catch (error) {
    if (signal?.aborted && !retryController.signal.aborted) {
      throw params.bodyReadOptions.onTimeout({ timeoutMs: initialTimeoutMs });
    }
    throw error;
  } finally {
    cleanup();
  }
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
    timeoutMs: params.timeoutMs ?? defaultTimeoutMs,
    label: `${params.providerLabel} video generation`,
  });
  const bodyReadOptions = createDashscopeBodyReadOptions({
    label: deadline.label,
    timeoutMs: createProviderOperationTimeoutResolver({ deadline, defaultTimeoutMs }),
    totalTimeoutMs: deadline.timeoutMs,
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
    await assertOkOrThrowHttpError(response, `${params.providerLabel} video generation failed`, {
      bodyTimeoutMs: bodyReadOptions.timeoutMs,
      onBodyTimeout: bodyReadOptions.onTimeout,
    });
    const submitted = await readProviderJsonResponse<DashscopeVideoGenerationResponse>(
      response,
      `${params.providerLabel} video generation`,
      bodyReadOptions,
    );
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
      throw new Error(
        `${params.providerLabel} video generation completed without output video URLs`,
      );
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
  } finally {
    await release();
  }
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
  if (params.urls.length === 0) {
    return [];
  }
  const defaultTimeoutMs = params.defaultTimeoutMs ?? DEFAULT_VIDEO_GENERATION_TIMEOUT_MS;
  const label = `${params.providerLabel} generated video download`;
  const deadline =
    typeof params.timeoutMs === "function"
      ? undefined
      : createProviderOperationDeadline({
          timeoutMs: resolveDashscopeVideoDownloadTimeoutMs(
            params.providerLabel,
            params.timeoutMs,
            defaultTimeoutMs,
          ),
          label,
        });
  const resolveTimeoutMs = deadline
    ? createProviderOperationTimeoutResolver({ deadline, defaultTimeoutMs })
    : () =>
        resolveDashscopeVideoDownloadTimeoutMs(
          params.providerLabel,
          params.timeoutMs,
          defaultTimeoutMs,
        );
  const bodyReadOptions = createDashscopeBodyReadOptions({
    label,
    timeoutMs: resolveTimeoutMs,
    totalTimeoutMs: deadline?.timeoutMs,
  });
  const videos: GeneratedVideoAsset[] = [];
  for (const [index, url] of params.urls.entries()) {
    const result = await fetchDashscopeGuardedResponse({
      providerLabel: params.providerLabel,
      stage: "download",
      url,
      timeoutMs: resolveTimeoutMs,
      bodyReadOptions,
      failureLabel: `${params.providerLabel} generated video download failed`,
      fetchFn: params.fetchFn,
      allowPrivateNetwork: params.allowPrivateNetwork,
      dispatcherPolicy: params.dispatcherPolicy,
    });
    let buffer: Buffer;
    let mimeType: string;
    try {
      // Re-resolve after headers so the body uses the remaining operation budget.
      let downloadTimeoutMs: number;
      try {
        downloadTimeoutMs = resolveTimeoutMs();
      } catch (error) {
        // The body reader normally owns cancellation. If deadline resolution
        // fails first, cancel here before release clears the guarded abort.
        await result.response.body?.cancel(error).catch(() => undefined);
        throw error;
      }
      buffer = await readResponseWithLimit(result.response, params.maxBytes, {
        ...bodyReadOptions,
        timeoutMs: downloadTimeoutMs,
        onOverflow: ({ maxBytes }) =>
          new Error(`${params.providerLabel} generated video download exceeds ${maxBytes} bytes`),
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
