// Minimax provider module implements model/runtime integration.
import { toImageDataUrl } from "openclaw/plugin-sdk/image-generation";
import {
  downloadGeneratedVideoAsset,
  resolveGeneratedMediaMaxBytes,
} from "openclaw/plugin-sdk/media-generation-runtime";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  createProviderOperationDeadline,
  createProviderOperationTimeoutResolver,
  executeProviderOperationWithRetry,
  fetchWithTimeoutGuarded,
  postJsonRequest,
  readProviderJsonResponse,
  resolveProviderOperationTimeoutMs,
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
  waitProviderOperationPollInterval,
  type ProviderOperationRetryStage,
  type ProviderOperationTimeoutMs,
  type TransientProviderRetryConfig,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationRequest,
} from "openclaw/plugin-sdk/video-generation";
import {
  assertMinimaxBaseResp,
  DEFAULT_MINIMAX_MEDIA_BASE_URL,
  resolveMinimaxGuardedRequestOptions,
  resolveMinimaxMediaBaseUrl,
  type MinimaxBaseResp,
  type MinimaxRequestPolicy,
} from "./media-provider-runtime.js";

const DEFAULT_MINIMAX_VIDEO_MODEL = "MiniMax-Hailuo-2.3";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 1_200_000;
const POLL_INTERVAL_MS = 10_000;
const MAX_POLL_ATTEMPTS = 120;
const MINIMAX_MODEL_ALLOWED_DURATIONS: Readonly<Record<string, readonly number[]>> = {
  "MiniMax-Hailuo-2.3": [6, 10],
  "MiniMax-Hailuo-02": [6, 10],
};
const MINIMAX_MODEL_ALLOWED_RESOLUTIONS: Readonly<Record<string, readonly string[]>> = {
  "MiniMax-Hailuo-2.3": ["768P", "1080P"],
  "MiniMax-Hailuo-2.3-Fast": ["768P", "1080P"],
  "MiniMax-Hailuo-02": ["768P", "1080P"],
};
const MINIMAX_RESOLUTION_ORDER = ["480P", "720P", "768P", "1080P"] as const;

type MinimaxCreateResponse = {
  task_id?: string;
  base_resp?: MinimaxBaseResp;
};

type MinimaxQueryResponse = {
  task_id?: string;
  status?: string;
  file_id?: string;
  video_url?: string;
  base_resp?: MinimaxBaseResp;
};

type MinimaxFileRetrieveResponse = {
  file?: {
    download_url?: string;
    filename?: string;
  };
  base_resp?: MinimaxBaseResp;
};

type MinimaxResponseHandle = {
  response: Response;
  release: () => Promise<void>;
};

function resolveMinimaxRequestTimeoutMs(
  timeoutMs: ProviderOperationTimeoutMs | undefined,
): number | undefined {
  const resolved = typeof timeoutMs === "function" ? timeoutMs() : timeoutMs;
  return typeof resolved === "number" && Number.isFinite(resolved) && resolved > 0
    ? resolved
    : undefined;
}

async function fetchMinimaxResponse(params: {
  stage: ProviderOperationRetryStage;
  url: string;
  init?: RequestInit;
  timeoutMs?: ProviderOperationTimeoutMs;
  fetchFn: typeof fetch;
  requestFailedMessage: string;
  policy: MinimaxRequestPolicy;
  retry?: TransientProviderRetryConfig;
}): Promise<MinimaxResponseHandle> {
  return await executeProviderOperationWithRetry({
    provider: "minimax",
    stage: params.stage,
    retry: params.retry,
    operation: async () => {
      const result = await fetchWithTimeoutGuarded(
        params.url,
        params.init ?? {},
        resolveMinimaxRequestTimeoutMs(params.timeoutMs),
        params.fetchFn,
        resolveMinimaxGuardedRequestOptions(params.policy),
      );
      try {
        await assertOkOrThrowHttpError(result.response, params.requestFailedMessage);
      } catch (error) {
        await result.release();
        throw error;
      }
      return result;
    },
  });
}

function resolveFirstFrameImage(req: VideoGenerationRequest): string | undefined {
  const input = req.inputImages?.[0];
  if (!input) {
    return undefined;
  }
  const inputUrl = normalizeOptionalString(input.url);
  if (inputUrl) {
    return inputUrl;
  }
  if (!input.buffer) {
    throw new Error("MiniMax image-to-video input is missing image data.");
  }
  return toImageDataUrl({ ...input, buffer: input.buffer, defaultMimeType: "image/png" });
}

function resolveDurationSeconds(params: {
  model: string;
  durationSeconds: number | undefined;
}): number | undefined {
  if (typeof params.durationSeconds !== "number" || !Number.isFinite(params.durationSeconds)) {
    return undefined;
  }
  const rounded = Math.max(1, Math.round(params.durationSeconds));
  const allowed = MINIMAX_MODEL_ALLOWED_DURATIONS[params.model];
  if (!allowed || allowed.length === 0) {
    return rounded;
  }
  return allowed.reduce((best, current) =>
    Math.abs(current - rounded) < Math.abs(best - rounded) ? current : best,
  );
}

function resolveResolution(params: {
  model: string;
  resolution: string | undefined;
}): string | undefined {
  const requested = normalizeOptionalString(params.resolution)?.toUpperCase();
  if (!requested) {
    return undefined;
  }
  const allowed = MINIMAX_MODEL_ALLOWED_RESOLUTIONS[params.model];
  if (!allowed || allowed.length === 0 || allowed.includes(requested)) {
    return requested;
  }
  const requestedIndex = MINIMAX_RESOLUTION_ORDER.indexOf(
    requested as (typeof MINIMAX_RESOLUTION_ORDER)[number],
  );
  if (requestedIndex < 0) {
    return undefined;
  }
  return allowed.reduce((best, current) => {
    const currentIndex = MINIMAX_RESOLUTION_ORDER.indexOf(
      current as (typeof MINIMAX_RESOLUTION_ORDER)[number],
    );
    const bestIndex = MINIMAX_RESOLUTION_ORDER.indexOf(
      best as (typeof MINIMAX_RESOLUTION_ORDER)[number],
    );
    if (currentIndex < 0) {
      return best;
    }
    if (bestIndex < 0) {
      return current;
    }
    return Math.abs(currentIndex - requestedIndex) < Math.abs(bestIndex - requestedIndex)
      ? current
      : best;
  });
}

async function pollMinimaxVideo(params: {
  taskId: string;
  headers: Headers;
  timeoutMs?: number;
  baseUrl: string;
  fetchFn: typeof fetch;
  policy: MinimaxRequestPolicy;
}): Promise<MinimaxQueryResponse> {
  const deadline = createProviderOperationDeadline({
    timeoutMs: params.timeoutMs,
    label: `MiniMax video generation task ${params.taskId}`,
  });
  const resolveTimeoutMs = createProviderOperationTimeoutResolver({
    deadline,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  });
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    const url = new URL(`${params.baseUrl}/v1/query/video_generation`);
    url.searchParams.set("task_id", params.taskId);
    const { response, release } = await fetchMinimaxResponse({
      stage: "poll",
      url: url.toString(),
      init: {
        method: "GET",
        headers: params.headers,
      },
      timeoutMs: resolveTimeoutMs,
      fetchFn: params.fetchFn,
      requestFailedMessage: "MiniMax video status request failed",
      policy: params.policy,
    });
    let payload: MinimaxQueryResponse;
    try {
      payload = await readProviderJsonResponse<MinimaxQueryResponse>(
        response,
        "MiniMax video generation failed",
        {
          timeoutMs: resolveTimeoutMs,
          onTimeout: ({ timeoutMs }) =>
            new Error(`MiniMax video generation timed out after ${timeoutMs}ms`),
        },
      );
    } finally {
      await release();
    }
    assertMinimaxBaseResp(payload.base_resp, "MiniMax video generation failed");
    switch (normalizeOptionalString(payload.status)) {
      case "Success":
        return payload;
      case "Fail":
        throw new Error(
          normalizeOptionalString(payload.base_resp?.status_msg) ||
            "MiniMax video generation failed",
        );
      default:
        await waitProviderOperationPollInterval({ deadline, pollIntervalMs: POLL_INTERVAL_MS });
        break;
    }
  }
  throw new Error(`MiniMax video generation task ${params.taskId} did not finish in time`);
}

async function downloadVideoFromUrl(params: {
  url: string;
  timeoutMs?: ProviderOperationTimeoutMs;
  fetchFn: typeof fetch;
  maxBytes: number;
  policy: MinimaxRequestPolicy;
}): Promise<GeneratedVideoAsset> {
  return await downloadGeneratedVideoAsset({
    url: params.url,
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    fetchFn: params.fetchFn,
    provider: "minimax",
    label: "MiniMax generated video download",
    requestFailedMessage: "MiniMax generated video download failed",
    maxBytes: params.maxBytes,
    validateBinaryResponse: true,
    chunkTimeoutMs: 0,
    fetchResponse: async ({ timeoutMs }) =>
      await fetchMinimaxResponse({
        stage: "download",
        url: params.url,
        init: { method: "GET" },
        timeoutMs,
        fetchFn: params.fetchFn,
        requestFailedMessage: "MiniMax generated video download failed",
        policy: params.policy,
      }),
  });
}

async function downloadVideoFromFileId(params: {
  fileId: string;
  headers: Headers;
  timeoutMs?: ProviderOperationTimeoutMs;
  baseUrl: string;
  fetchFn: typeof fetch;
  maxBytes: number;
  policy: MinimaxRequestPolicy;
}): Promise<GeneratedVideoAsset> {
  const url = new URL(`${params.baseUrl}/v1/files/retrieve`);
  url.searchParams.set("file_id", params.fileId);
  const metadataDeadline = createProviderOperationDeadline({
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    label: "MiniMax generated video metadata",
  });
  const metadataTimeoutMs = createProviderOperationTimeoutResolver({
    deadline: metadataDeadline,
    defaultTimeoutMs: metadataDeadline.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  const { response: metadataResponse, release: releaseMetadata } = await fetchMinimaxResponse({
    stage: "download",
    url: url.toString(),
    init: {
      method: "GET",
      headers: params.headers,
    },
    timeoutMs: metadataTimeoutMs,
    fetchFn: params.fetchFn,
    requestFailedMessage: "MiniMax generated video metadata request failed",
    policy: params.policy,
  });
  let metadata: MinimaxFileRetrieveResponse;
  try {
    metadata = await readProviderJsonResponse<MinimaxFileRetrieveResponse>(
      metadataResponse,
      "MiniMax generated video metadata",
      {
        timeoutMs: metadataTimeoutMs,
        onTimeout: ({ timeoutMs: bodyTimeoutMs }) =>
          new Error(
            `MiniMax generated video metadata timed out after ${metadataDeadline.timeoutMs ?? bodyTimeoutMs}ms`,
          ),
      },
    );
  } finally {
    await releaseMetadata();
  }
  assertMinimaxBaseResp(metadata.base_resp, "MiniMax generated video metadata request failed");
  const downloadUrl = normalizeOptionalString(metadata.file?.download_url);
  if (!downloadUrl) {
    throw new Error("MiniMax generated video metadata missing download_url");
  }
  const video = await downloadVideoFromUrl({
    url: downloadUrl,
    timeoutMs: params.timeoutMs,
    fetchFn: params.fetchFn,
    maxBytes: params.maxBytes,
    policy: params.policy,
  });
  return {
    ...video,
    fileName: normalizeOptionalString(metadata.file?.filename) || video.fileName,
  };
}

function buildMinimaxVideoProvider(providerId: string): VideoGenerationProvider {
  return {
    id: providerId,
    label: "MiniMax",
    defaultModel: DEFAULT_MINIMAX_VIDEO_MODEL,
    models: [
      DEFAULT_MINIMAX_VIDEO_MODEL,
      "MiniMax-Hailuo-2.3-Fast",
      "MiniMax-Hailuo-02",
      "I2V-01-Director",
      "I2V-01-live",
      "I2V-01",
    ],
    isConfigured: (ctx) => isProviderApiKeyConfigured({ provider: providerId, ...ctx }),
    capabilities: {
      generate: {
        maxVideos: 1,
        maxDurationSeconds: 10,
        supportedDurationSecondsByModel: MINIMAX_MODEL_ALLOWED_DURATIONS,
        resolutions: ["768P", "1080P"],
        supportsResolution: true,
        supportsWatermark: false,
      },
      imageToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputImages: 1,
        maxDurationSeconds: 10,
        supportedDurationSecondsByModel: MINIMAX_MODEL_ALLOWED_DURATIONS,
        resolutions: ["768P", "1080P"],
        supportsResolution: true,
        supportsWatermark: false,
      },
      videoToVideo: {
        enabled: false,
      },
    },
    async generateVideo(req) {
      if ((req.inputVideos?.length ?? 0) > 0) {
        throw new Error("MiniMax video generation does not support video reference inputs.");
      }
      const auth = await resolveApiKeyForProvider({
        provider: providerId,
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("MiniMax API key missing");
      }

      const fetchFn = fetch;
      const deadline = createProviderOperationDeadline({
        timeoutMs: req.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
        label: "MiniMax video generation",
      });
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: resolveMinimaxMediaBaseUrl(req.cfg, providerId),
          defaultBaseUrl: DEFAULT_MINIMAX_MEDIA_BASE_URL,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
            "Content-Type": "application/json",
          },
          provider: providerId,
          capability: "video",
          transport: "http",
          request: sanitizeConfiguredModelProviderRequest(
            req.cfg.models?.providers?.[providerId]?.request,
          ),
        });
      const requestPolicy: MinimaxRequestPolicy = { allowPrivateNetwork, dispatcherPolicy };
      const model = normalizeOptionalString(req.model) ?? DEFAULT_MINIMAX_VIDEO_MODEL;
      const body: Record<string, unknown> = {
        model,
        prompt: req.prompt,
      };
      const firstFrameImage = resolveFirstFrameImage(req);
      if (firstFrameImage) {
        body.first_frame_image = firstFrameImage;
      }
      const resolution = resolveResolution({
        model,
        resolution: req.resolution,
      });
      if (resolution) {
        body.resolution = resolution;
      }
      const durationSeconds = resolveDurationSeconds({
        model,
        durationSeconds: req.durationSeconds,
      });
      if (typeof durationSeconds === "number") {
        body.duration = durationSeconds;
      }
      const { response, release } = await postJsonRequest({
        url: `${baseUrl}/v1/video_generation`,
        headers,
        body,
        timeoutMs: resolveProviderOperationTimeoutMs({
          deadline,
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
        }),
        fetchFn,
        allowPrivateNetwork,
        dispatcherPolicy,
      });
      try {
        await assertOkOrThrowHttpError(response, "MiniMax video generation failed");
        const submitted = await readProviderJsonResponse<MinimaxCreateResponse>(
          response,
          "MiniMax video generation failed",
        );
        assertMinimaxBaseResp(submitted.base_resp, "MiniMax video generation failed");
        const taskId = normalizeOptionalString(submitted.task_id);
        if (!taskId) {
          throw new Error("MiniMax video generation response missing task_id");
        }
        const completed = await pollMinimaxVideo({
          taskId,
          headers,
          timeoutMs: resolveProviderOperationTimeoutMs({
            deadline,
            defaultTimeoutMs: DEFAULT_OPERATION_TIMEOUT_MS,
          }),
          baseUrl,
          fetchFn,
          policy: requestPolicy,
        });
        const videoUrl = normalizeOptionalString(completed.video_url);
        const fileId = normalizeOptionalString(completed.file_id);
        const maxVideoBytes = resolveGeneratedMediaMaxBytes(req.cfg, "video");
        const video = videoUrl
          ? await downloadVideoFromUrl({
              url: videoUrl,
              timeoutMs: createProviderOperationTimeoutResolver({
                deadline,
                defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
              }),
              fetchFn,
              maxBytes: maxVideoBytes,
              policy: requestPolicy,
            })
          : fileId
            ? await downloadVideoFromFileId({
                fileId,
                headers,
                timeoutMs: createProviderOperationTimeoutResolver({
                  deadline,
                  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
                }),
                baseUrl,
                fetchFn,
                maxBytes: maxVideoBytes,
                policy: requestPolicy,
              })
            : (() => {
                throw new Error(
                  "MiniMax video generation completed without a video URL or file_id",
                );
              })();
        return {
          videos: [video],
          model,
          metadata: {
            taskId,
            status: completed.status,
            fileId,
            videoUrl,
          },
        };
      } finally {
        await release();
      }
    },
  };
}

export function buildMinimaxVideoGenerationProvider(): VideoGenerationProvider {
  return buildMinimaxVideoProvider("minimax");
}

export function buildMinimaxPortalVideoGenerationProvider(): VideoGenerationProvider {
  return buildMinimaxVideoProvider("minimax-portal");
}
