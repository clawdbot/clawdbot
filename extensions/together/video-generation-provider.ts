// Together provider module implements model/runtime integration.
import { toImageDataUrl } from "openclaw/plugin-sdk/image-generation";
import { extensionForMime } from "openclaw/plugin-sdk/media-mime";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  createProviderOperationDeadline,
  createProviderOperationTimeoutResolver,
  fetchProviderDownloadResponse,
  pollProviderOperationJson,
  postJsonRequest,
  readProviderJsonResponse,
  resolveProviderOperationTimeoutMs,
  resolveProviderHttpRequestConfig,
  type ProviderOperationTimeoutMs,
} from "openclaw/plugin-sdk/provider-http";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import {
  asSafeIntegerInRange,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationRequest,
} from "openclaw/plugin-sdk/video-generation";
import { TOGETHER_BASE_URL } from "./models.js";

const DEFAULT_TOGETHER_VIDEO_MODEL = "Wan-AI/Wan2.2-T2V-A14B";
const TOGETHER_IMAGE_TO_VIDEO_MODELS = new Set(["Wan-AI/Wan2.2-I2V-A14B"]);
const TOGETHER_VIDEO_BASE_URL = "https://api.together.xyz/v2";
const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 120;
const TOGETHER_MIN_DURATION_SECONDS = 1;
const TOGETHER_MAX_DURATION_SECONDS = 10;
const DEFAULT_GENERATED_VIDEO_MAX_BYTES = 16 * 1024 * 1024;

type TogetherVideoResponse = {
  id?: string;
  model?: string;
  status?: "in_progress" | "completed" | "failed";
  error?: {
    code?: string;
    message?: string;
  } | null;
  outputs?:
    | {
        video_url?: string;
        url?: string;
      }
    | Array<{
        video_url?: string;
        url?: string;
      }>;
};

// Reads the Together create-video response through the shared provider JSON
// reader so a provider that streams an unbounded JSON body cannot force the
// runtime to buffer the whole payload before parsing it on the success path.
// The shared helper applies the established 16 MiB provider JSON cap and the
// standard malformed-JSON wrapping instead of a provider-local reimplementation.
async function readTogetherVideoJson(response: Response): Promise<TogetherVideoResponse> {
  return (await readProviderJsonResponse(
    response,
    "Together video generation failed",
  )) as TogetherVideoResponse;
}

function resolveTogetherVideoBaseUrl(req: VideoGenerationRequest): string {
  const configuredBaseUrl = normalizeOptionalString(req.cfg?.models?.providers?.together?.baseUrl);
  if (
    !configuredBaseUrl ||
    stripTrailingSlash(configuredBaseUrl) === stripTrailingSlash(TOGETHER_BASE_URL)
  ) {
    return TOGETHER_VIDEO_BASE_URL;
  }
  return configuredBaseUrl;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function extractTogetherVideoUrl(payload: TogetherVideoResponse): string | undefined {
  if (Array.isArray(payload.outputs)) {
    for (const entry of payload.outputs) {
      const url = normalizeOptionalString(entry.video_url) ?? normalizeOptionalString(entry.url);
      if (url) {
        return url;
      }
    }
    return undefined;
  }
  return (
    normalizeOptionalString(payload.outputs?.video_url) ??
    normalizeOptionalString(payload.outputs?.url)
  );
}

function resolveTogetherDurationSeconds(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const duration = asSafeIntegerInRange(Math.round(value), {
    min: TOGETHER_MIN_DURATION_SECONDS,
    max: TOGETHER_MAX_DURATION_SECONDS,
  });
  return duration === undefined ? undefined : String(duration);
}

function resolveGeneratedVideoMaxBytes(req: VideoGenerationRequest): number {
  const configured = req.cfg.agents?.defaults?.mediaMaxMb;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured * 1024 * 1024);
  }
  return DEFAULT_GENERATED_VIDEO_MAX_BYTES;
}

async function pollTogetherVideo(params: {
  videoId: string;
  headers: Headers;
  timeoutMs?: number;
  baseUrl: string;
  fetchFn: typeof fetch;
}): Promise<TogetherVideoResponse> {
  const deadline = createProviderOperationDeadline({
    timeoutMs: params.timeoutMs,
    label: `Together video generation task ${params.videoId}`,
  });
  return await pollProviderOperationJson<TogetherVideoResponse>({
    url: `${params.baseUrl}/videos/${params.videoId}`,
    headers: params.headers,
    deadline,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    fetchFn: params.fetchFn,
    maxAttempts: MAX_POLL_ATTEMPTS,
    pollIntervalMs: POLL_INTERVAL_MS,
    requestFailedMessage: "Together video status request failed",
    timeoutMessage: `Together video generation task ${params.videoId} did not finish in time`,
    isComplete: (payload) => payload.status === "completed",
    getFailureMessage: (payload) =>
      payload.status === "failed"
        ? (normalizeOptionalString(payload.error?.message) ?? "Together video generation failed")
        : undefined,
  });
}

async function downloadTogetherVideo(params: {
  url: string;
  timeoutMs?: ProviderOperationTimeoutMs;
  fetchFn: typeof fetch;
  maxBytes: number;
}): Promise<GeneratedVideoAsset> {
  const deadline = createProviderOperationDeadline({
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    label: "Together generated video download",
  });
  const timeoutMs = createProviderOperationTimeoutResolver({
    deadline,
    defaultTimeoutMs: deadline.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  const response = await fetchProviderDownloadResponse({
    url: params.url,
    init: { method: "GET" },
    deadline,
    fetchFn: params.fetchFn,
    provider: "together",
    requestFailedMessage: "Together generated video download failed",
  });
  const mimeType = normalizeOptionalString(response.headers.get("content-type")) ?? "video/mp4";
  const buffer = await readResponseWithLimit(response, params.maxBytes, {
    timeoutMs,
    onTimeout: ({ timeoutMs: bodyTimeoutMs }) =>
      new Error(
        `Together generated video download timed out after ${deadline.timeoutMs ?? bodyTimeoutMs}ms`,
      ),
    onOverflow: ({ maxBytes }) =>
      new Error(`Together generated video download exceeds ${maxBytes} bytes`),
  });
  return {
    buffer,
    mimeType,
    fileName: `video-1.${extensionForMime(mimeType)?.slice(1) ?? "mp4"}`,
  };
}

export function buildTogetherVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: "together",
    label: "Together",
    defaultModel: DEFAULT_TOGETHER_VIDEO_MODEL,
    models: [
      DEFAULT_TOGETHER_VIDEO_MODEL,
      "Wan-AI/Wan2.2-I2V-A14B",
      "minimax/hailuo-02",
      "kwaivgI/kling-2.1-master",
    ],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "together",
        agentDir,
      }),
    capabilities: {
      generate: {
        maxVideos: 1,
        maxDurationSeconds: TOGETHER_MAX_DURATION_SECONDS,
        supportsSize: true,
      },
      imageToVideo: {
        enabled: true,
        maxInputImagesByModel: {
          "Wan-AI/Wan2.2-I2V-A14B": 1,
        },
        maxDurationSeconds: TOGETHER_MAX_DURATION_SECONDS,
        supportsSize: true,
      },
      videoToVideo: {
        enabled: false,
      },
    },
    async generateVideo(req) {
      if ((req.inputVideos?.length ?? 0) > 0) {
        throw new Error("Together video generation does not support video reference inputs.");
      }
      const auth = await resolveApiKeyForProvider({
        provider: "together",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("Together API key missing");
      }

      const fetchFn = fetch;
      const deadline = createProviderOperationDeadline({
        timeoutMs: req.timeoutMs,
        label: "Together video generation",
      });
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: resolveTogetherVideoBaseUrl(req),
          defaultBaseUrl: TOGETHER_VIDEO_BASE_URL,
          allowPrivateNetwork: false,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
            "Content-Type": "application/json",
          },
          provider: "together",
          capability: "video",
          transport: "http",
        });
      const body: Record<string, unknown> = {
        model: normalizeOptionalString(req.model) ?? DEFAULT_TOGETHER_VIDEO_MODEL,
        prompt: req.prompt,
      };
      const model = String(body.model);
      const duration = resolveTogetherDurationSeconds(req.durationSeconds);
      if (duration !== undefined) {
        body.seconds = duration;
      }
      const size = normalizeOptionalString(req.size);
      if (size) {
        const match = /^(\d+)x(\d+)$/u.exec(size);
        if (match) {
          body.width = Number.parseInt(match[1] ?? "", 10);
          body.height = Number.parseInt(match[2] ?? "", 10);
        }
      }
      if (req.inputImages?.[0]) {
        if (!TOGETHER_IMAGE_TO_VIDEO_MODELS.has(model)) {
          throw new Error(
            `Together video model ${model} does not support image reference inputs. Use Wan-AI/Wan2.2-I2V-A14B or omit input images.`,
          );
        }
        const input = req.inputImages[0];
        const value = normalizeOptionalString(input.url)
          ? normalizeOptionalString(input.url)
          : input.buffer
            ? toImageDataUrl({ ...input, buffer: input.buffer, defaultMimeType: "image/png" })
            : undefined;
        if (!value) {
          throw new Error("Together reference image is missing image data.");
        }
        body.reference_images = [value];
      }
      const { response, release } = await postJsonRequest({
        url: `${baseUrl}/videos`,
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
        await assertOkOrThrowHttpError(response, "Together video generation failed");
        const submitted = await readTogetherVideoJson(response);
        const videoId = normalizeOptionalString(submitted.id);
        if (!videoId) {
          throw new Error("Together video generation response missing id");
        }
        const completed = await pollTogetherVideo({
          videoId,
          headers,
          timeoutMs: resolveProviderOperationTimeoutMs({
            deadline,
            defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
          }),
          baseUrl,
          fetchFn,
        });
        const videoUrl = extractTogetherVideoUrl(completed);
        if (!videoUrl) {
          throw new Error("Together video generation completed without an output URL");
        }
        const video = await downloadTogetherVideo({
          url: videoUrl,
          timeoutMs: createProviderOperationTimeoutResolver({
            deadline,
            defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
          }),
          fetchFn,
          maxBytes: resolveGeneratedVideoMaxBytes(req),
        });
        return {
          videos: [video],
          model: completed.model ?? req.model ?? DEFAULT_TOGETHER_VIDEO_MODEL,
          metadata: {
            videoId,
            status: completed.status,
            videoUrl,
          },
        };
      } finally {
        await release();
      }
    },
  };
}
