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

const DEFAULT_MINIMAX_VIDEO_BASE_URL = "https://api.minimax.io";
const DEFAULT_MINIMAX_VIDEO_MODEL = "MiniMax-Hailuo-2.3";
const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 10_000;
const MAX_POLL_ATTEMPTS = 90;
const MINIMAX_MODEL_ALLOWED_DURATIONS: Readonly<Record<string, readonly number[]>> = {
  "MiniMax-Hailuo-2.3": [6, 10],
  "MiniMax-Hailuo-02": [6, 10],
};

type MinimaxBaseResp = {
  status_code?: number;
  status_msg?: string;
};

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

function resolveMinimaxVideoBaseUrl(
  cfg: Parameters<typeof resolveApiKeyForProvider>[0]["cfg"],
): string {
  const direct = normalizeOptionalString(cfg?.models?.providers?.minimax?.baseUrl);
  if (!direct) {
    return DEFAULT_MINIMAX_VIDEO_BASE_URL;
  }
  try {
    return new URL(direct).origin;
  } catch {
    return DEFAULT_MINIMAX_VIDEO_BASE_URL;
  }
}

function assertMinimaxBaseResp(baseResp: MinimaxBaseResp | undefined, context: string): void {
  if (!baseResp || typeof baseResp.status_code !== "number" || baseResp.status_code === 0) {
    return;
  }
  throw new Error(
    `${context} (${baseResp.status_code}): ${baseResp.status_msg ?? "unknown error"}`,
  );
}

function toDataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
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
  return toDataUrl(input.buffer, normalizeOptionalString(input.mimeType) ?? "image/png");
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

async function pollMinimaxVideo(params: {
  taskId: string;
  headers: Headers;
  timeoutMs?: number;
  baseUrl: string;
  fetchFn: typeof fetch;
}): Promise<MinimaxQueryResponse> {
  const deadline = createProviderOperationDeadline({
    timeoutMs: params.timeoutMs,
    label: `MiniMax video generation task ${params.taskId}`,
  });
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    const url = new URL(`${params.baseUrl}/v1/query/video_generation`);
    url.searchParams.set("task_id", params.taskId);
    const response = await fetchWithTimeout(
      url.toString(),
      {
        method: "GET",
        headers: params.headers,
      },
      resolveProviderOperationTimeoutMs({ deadline, defaultTimeoutMs: DEFAULT_TIMEOUT_MS }),
      params.fetchFn,
    );
    await assertOkOrThrowHttpError(response, "MiniMax video status request failed");
    const payload = (await response.json()) as MinimaxQueryResponse;
    assertMinimaxBaseResp(payload.base_resp, "MiniMax video generation failed");
    switch (normalizeOptionalString(payload.status)) {
      case "Success":
        return payload;
      case "Fail":
        throw new Error(
          normalizeOptionalString(payload.base_resp?.status_msg) ||
            "MiniMax video generation failed",
        );
      case "Preparing":
      case "Processing":
      default:
        await waitProviderOperationPollInterval({ deadline, pollIntervalMs: POLL_INTERVAL_MS });
        break;
    }
  }
  throw new Error(`MiniMax video generation task ${params.taskId} did not finish in time`);
}

async function downloadVideoFromUrl(params: {
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
  await assertOkOrThrowHttpError(response, "MiniMax generated video download failed");
  const mimeType = normalizeOptionalString(response.headers.get("content-type")) ?? "video/mp4";
  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType,
    fileName: `video-1.${mimeType.includes("webm") ? "webm" : "mp4"}`,
  };
}

async function downloadVideoFromFileId(params: {
  fileId: string;
  headers: Headers;
  timeoutMs?: number;
  baseUrl: string;
  fetchFn: typeof fetch;
}): Promise<GeneratedVideoAsset> {
  const url = new URL(`${params.baseUrl}/v1/files/retrieve`);
  url.searchParams.set("file_id", params.fileId);
  const metadataResponse = await fetchWithTimeout(
    url.toString(),
    {
      method: "GET",
      headers: params.headers,
    },
    params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    params.fetchFn,
  );
  await assertOkOrThrowHttpError(
    metadataResponse,
    "MiniMax generated video metadata request failed",
  );
  const metadata = (await metadataResponse.json()) as MinimaxFileRetrieveResponse;
  assertMinimaxBaseResp(metadata.base_resp, "MiniMax generated video metadata request failed");
  const downloadUrl = normalizeOptionalString(metadata.file?.download_url);
  if (!downloadUrl) {
    throw new Error("MiniMax generated video metadata missing download_url");
  }
  const response = await fetchWithTimeout(
    downloadUrl,
    { method: "GET" },
    params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    params.fetchFn,
  );
  await assertOkOrThrowHttpError(response, "MiniMax generated video download failed");
  const mimeType = normalizeOptionalString(response.headers.get("content-type")) ?? "video/mp4";
  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType,
    fileName:
      normalizeOptionalString(metadata.file?.filename) ||
      `video-1.${mimeType.includes("webm") ? "webm" : "mp4"}`,
  };
}

export function buildMinimaxVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: "minimax",
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
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "minimax",
        agentDir,
      }),
    capabilities: {
      generate: {
        maxVideos: 1,
        maxDurationSeconds: 10,
        supportedDurationSecondsByModel: MINIMAX_MODEL_ALLOWED_DURATIONS,
        supportsResolution: true,
        supportsWatermark: false,
      },
      imageToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputImages: 1,
        maxDurationSeconds: 10,
        supportedDurationSecondsByModel: MINIMAX_MODEL_ALLOWED_DURATIONS,
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
        provider: "minimax",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("MiniMax API key missing");
      }

      const fetchFn = fetch;
      const deadline = createProviderOperationDeadline({
        timeoutMs: req.timeoutMs,
        label: "MiniMax video generation",
      });
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: resolveMinimaxVideoBaseUrl(req.cfg),
          defaultBaseUrl: DEFAULT_MINIMAX_VIDEO_BASE_URL,
          allowPrivateNetwork: false,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
            "Content-Type": "application/json",
          },
          provider: "minimax",
          capability: "video",
          transport: "http",
        });
      const model = normalizeOptionalString(req.model) ?? DEFAULT_MINIMAX_VIDEO_MODEL;
      const body: Record<string, unknown> = {
        model,
        prompt: req.prompt,
      };
      const firstFrameImage = resolveFirstFrameImage(req);
      if (firstFrameImage) {
        body.first_frame_image = firstFrameImage;
      }
      if (req.resolution) {
        body.resolution = req.resolution;
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
        const submitted = (await response.json()) as MinimaxCreateResponse;
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
            defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
          }),
          baseUrl,
          fetchFn,
        });
        const videoUrl = normalizeOptionalString(completed.video_url);
        const fileId = normalizeOptionalString(completed.file_id);
        const video = videoUrl
          ? await downloadVideoFromUrl({
              url: videoUrl,
              timeoutMs: resolveProviderOperationTimeoutMs({
                deadline,
                defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
              }),
              fetchFn,
            })
          : fileId
            ? await downloadVideoFromFileId({
                fileId,
                headers,
                timeoutMs: resolveProviderOperationTimeoutMs({
                  deadline,
                  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
                }),
                baseUrl,
                fetchFn,
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
