/**
 * BytePlus Seedance video generation provider implementation.
 */
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
  readProviderJsonResponse,
  resolveProviderOperationTimeoutMs,
  resolveProviderHttpRequestConfig,
  waitProviderOperationPollInterval,
  type ProviderOperationTimeoutMs,
} from "openclaw/plugin-sdk/provider-http";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import {
  asSafeIntegerInRange,
  isRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationRequest,
} from "openclaw/plugin-sdk/video-generation";
import { BYTEPLUS_BASE_URL } from "./models.js";

const DEFAULT_BYTEPLUS_VIDEO_MODEL = "seedance-1-0-lite-t2v-250428";
const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 120;
const BYTEPLUS_SEED_MAX = 2_147_483_647;
const BYTEPLUS_MIN_DURATION_SECONDS = 2;
const BYTEPLUS_MAX_DURATION_SECONDS = 12;
const DEFAULT_GENERATED_VIDEO_MAX_BYTES = 16 * 1024 * 1024;

type BytePlusTaskCreateResponse = {
  id?: unknown;
};

type BytePlusTaskResponse = {
  id?: unknown;
  model?: unknown;
  status?: unknown;
  error?: unknown;
  content?: unknown;
  duration?: unknown;
  ratio?: unknown;
  resolution?: unknown;
};

type BytePlusTaskStatus = "running" | "failed" | "queued" | "succeeded" | "cancelled";

async function readBytePlusJsonResponse<T>(response: Response, label: string): Promise<T> {
  // BytePlus submit/poll task bodies are read through the shared byte-bounded reader
  // (readResponseWithLimit, via readProviderJsonResponse) so a hostile or buggy endpoint
  // that streams an unbounded JSON body cannot force the runtime to buffer the whole
  // payload before parsing. Overflow cancels the stream and throws a bounded error;
  // malformed JSON keeps the existing `${label}: malformed JSON response` wrapping.
  const payload = await readProviderJsonResponse<unknown>(response, label);
  if (!isRecord(payload)) {
    throw new Error(`${label}: malformed JSON response`);
  }
  return payload as T;
}

function readBytePlusTaskStatus(payload: BytePlusTaskResponse): BytePlusTaskStatus {
  const status = normalizeOptionalString(payload.status);
  switch (status) {
    case "running":
    case "failed":
    case "queued":
    case "succeeded":
    case "cancelled":
      return status;
    case undefined:
      throw new Error("BytePlus video status response missing task status");
    default:
      throw new Error(`BytePlus video status response returned unknown task status: ${status}`);
  }
}

function readBytePlusErrorMessage(error: unknown): string | undefined {
  return isRecord(error) ? normalizeOptionalString(error.message) : undefined;
}

function readBytePlusVideoUrl(payload: BytePlusTaskResponse): string {
  const content = payload.content;
  if (content !== undefined && !isRecord(content)) {
    throw new Error("BytePlus video generation completed with malformed content");
  }
  const videoUrl = normalizeOptionalString(content?.video_url);
  if (!videoUrl) {
    throw new Error("BytePlus video generation completed without a video URL");
  }
  return videoUrl;
}

function resolveBytePlusVideoBaseUrl(req: VideoGenerationRequest): string {
  return (
    normalizeOptionalString(req.cfg?.models?.providers?.byteplus?.baseUrl) ?? BYTEPLUS_BASE_URL
  );
}

function resolveGeneratedVideoMaxBytes(req: VideoGenerationRequest): number {
  const configured = req.cfg.agents?.defaults?.mediaMaxMb;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured * 1024 * 1024);
  }
  return DEFAULT_GENERATED_VIDEO_MAX_BYTES;
}

function toDataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function resolveBytePlusImageUrl(req: VideoGenerationRequest): string | undefined {
  const input = req.inputImages?.[0];
  if (!input) {
    return undefined;
  }
  const inputUrl = normalizeOptionalString(input.url);
  if (inputUrl) {
    return inputUrl;
  }
  if (!input.buffer) {
    throw new Error("BytePlus reference image is missing image data.");
  }
  return toDataUrl(input.buffer, normalizeOptionalString(input.mimeType) ?? "image/png");
}

function resolveBytePlusSeed(value: unknown): number | undefined {
  return asSafeIntegerInRange(value, { min: -1, max: BYTEPLUS_SEED_MAX });
}

function resolveBytePlusDurationSeconds(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return asSafeIntegerInRange(Math.round(value), {
    min: BYTEPLUS_MIN_DURATION_SECONDS,
    max: BYTEPLUS_MAX_DURATION_SECONDS,
  });
}

function readBytePlusDurationSeconds(value: unknown): number | undefined {
  return asSafeIntegerInRange(value, {
    min: BYTEPLUS_MIN_DURATION_SECONDS,
    max: BYTEPLUS_MAX_DURATION_SECONDS,
  });
}

async function pollBytePlusTask(params: {
  taskId: string;
  headers: Headers;
  timeoutMs?: number;
  baseUrl: string;
  fetchFn: typeof fetch;
}): Promise<BytePlusTaskResponse> {
  const deadline = createProviderOperationDeadline({
    timeoutMs: params.timeoutMs,
    label: `BytePlus video generation task ${params.taskId}`,
  });
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    const response = await fetchProviderOperationResponse({
      stage: "poll",
      url: `${params.baseUrl}/contents/generations/tasks/${params.taskId}`,
      init: {
        method: "GET",
        headers: params.headers,
      },
      timeoutMs: createProviderOperationTimeoutResolver({
        deadline,
        defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      }),
      fetchFn: params.fetchFn,
      provider: "byteplus",
      requestFailedMessage: "BytePlus video status request failed",
    });
    const payload = await readBytePlusJsonResponse<BytePlusTaskResponse>(
      response,
      "BytePlus video status request failed",
    );
    switch (readBytePlusTaskStatus(payload)) {
      case "succeeded":
        return payload;
      case "failed":
      case "cancelled":
        throw new Error(
          readBytePlusErrorMessage(payload.error) || "BytePlus video generation failed",
        );
      default:
        await waitProviderOperationPollInterval({ deadline, pollIntervalMs: POLL_INTERVAL_MS });
        break;
    }
  }
  throw new Error(`BytePlus video generation task ${params.taskId} did not finish in time`);
}

async function downloadBytePlusVideo(params: {
  url: string;
  timeoutMs?: ProviderOperationTimeoutMs;
  fetchFn: typeof fetch;
  maxBytes: number;
}): Promise<GeneratedVideoAsset> {
  const response = await fetchProviderDownloadResponse({
    url: params.url,
    init: { method: "GET" },
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetchFn: params.fetchFn,
    provider: "byteplus",
    requestFailedMessage: "BytePlus generated video download failed",
  });
  const mimeType = normalizeOptionalString(response.headers.get("content-type")) ?? "video/mp4";
  const buffer = await readResponseWithLimit(response, params.maxBytes, {
    onOverflow: ({ maxBytes }) =>
      new Error(`BytePlus generated video download exceeds ${maxBytes} bytes`),
  });
  return {
    buffer,
    mimeType,
    fileName: `video-1.${extensionForMime(mimeType)?.slice(1) ?? "mp4"}`,
  };
}

/** Builds the BytePlus video generation provider registered by the plugin. */
export function buildBytePlusVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: "byteplus",
    label: "BytePlus",
    defaultModel: DEFAULT_BYTEPLUS_VIDEO_MODEL,
    models: [
      DEFAULT_BYTEPLUS_VIDEO_MODEL,
      "seedance-1-0-lite-i2v-250428",
      "seedance-1-0-pro-250528",
      "seedance-1-5-pro-251215",
    ],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "byteplus",
        agentDir,
      }),
    capabilities: {
      providerOptions: {
        seed: "number",
        draft: "boolean",
        camera_fixed: "boolean",
      },
      generate: {
        maxVideos: 1,
        maxDurationSeconds: 12,
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsAudio: true,
        supportsWatermark: true,
      },
      imageToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputImages: 1,
        maxDurationSeconds: 12,
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsAudio: true,
        supportsWatermark: true,
      },
      videoToVideo: {
        enabled: false,
      },
    },
    async generateVideo(req) {
      if ((req.inputVideos?.length ?? 0) > 0) {
        throw new Error("BytePlus video generation does not support video reference inputs.");
      }
      const auth = await resolveApiKeyForProvider({
        provider: "byteplus",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("BytePlus API key missing");
      }

      const fetchFn = fetch;
      const deadline = createProviderOperationDeadline({
        timeoutMs: req.timeoutMs,
        label: "BytePlus video generation",
      });
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: resolveBytePlusVideoBaseUrl(req),
          defaultBaseUrl: BYTEPLUS_BASE_URL,
          allowPrivateNetwork: false,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
            "Content-Type": "application/json",
          },
          provider: "byteplus",
          capability: "video",
          transport: "http",
        });
      // Seedance 1.0 has separate T2V and I2V model IDs (e.g. seedance-1-0-lite-t2v-250428 vs
      // seedance-1-0-lite-i2v-250428). When input images are provided with a T2V model, auto-
      // switch to the corresponding I2V variant so the API does not reject with task_type mismatch.
      // 1.5 Pro uses a single model ID for both modes and is unaffected by this substitution.
      const hasInputImages = (req.inputImages?.length ?? 0) > 0;
      const requestedModel = normalizeOptionalString(req.model) || DEFAULT_BYTEPLUS_VIDEO_MODEL;
      const resolvedModel =
        hasInputImages && requestedModel.includes("-t2v-")
          ? requestedModel.replace("-t2v-", "-i2v-")
          : requestedModel;

      const content: Array<Record<string, unknown>> = [{ type: "text", text: req.prompt }];
      const imageUrl = resolveBytePlusImageUrl(req);
      if (imageUrl) {
        content.push({
          type: "image_url",
          image_url: { url: imageUrl },
          role: "first_frame",
        });
      }
      const body: Record<string, unknown> = {
        model: resolvedModel,
        content,
      };
      const aspectRatio = normalizeOptionalString(req.aspectRatio);
      if (aspectRatio) {
        body.ratio = aspectRatio;
      }
      // Seedance API requires lowercase resolution values (e.g. "480p", "720p"); uppercase
      // variants like "480P" are rejected with InvalidParameter.
      const resolution = normalizeOptionalString(req.resolution)?.toLowerCase();
      if (resolution) {
        body.resolution = resolution;
      }
      const duration = resolveBytePlusDurationSeconds(req.durationSeconds);
      if (duration !== undefined) {
        body.duration = duration;
      }
      if (typeof req.audio === "boolean") {
        body.generate_audio = req.audio;
      }
      if (typeof req.watermark === "boolean") {
        body.watermark = req.watermark;
      }

      // Forward declared providerOptions: seed, draft, camerafixed.
      // draft=true forces 480p resolution for faster generation.
      const opts = req.providerOptions ?? {};
      const seed = resolveBytePlusSeed(opts.seed);
      const draft = opts.draft === true;
      // Official JSON body field is camera_fixed (with underscore).
      const cameraFixed = typeof opts.camera_fixed === "boolean" ? opts.camera_fixed : undefined;
      if (seed != null) {
        body.seed = seed;
      }
      if (draft && !body.resolution) {
        body.resolution = "480p";
      }
      if (cameraFixed != null) {
        body.camera_fixed = cameraFixed;
      }

      const { response, release } = await postJsonRequest({
        url: `${baseUrl}/contents/generations/tasks`,
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
        await assertOkOrThrowHttpError(response, "BytePlus video generation failed");
        const submitted = await readBytePlusJsonResponse<BytePlusTaskCreateResponse>(
          response,
          "BytePlus video generation failed",
        );
        const taskId = normalizeOptionalString(submitted.id);
        if (!taskId) {
          throw new Error("BytePlus video generation response missing task id");
        }
        const completed = await pollBytePlusTask({
          taskId,
          headers,
          timeoutMs: resolveProviderOperationTimeoutMs({
            deadline,
            defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
          }),
          baseUrl,
          fetchFn,
        });
        const videoUrl = readBytePlusVideoUrl(completed);
        const video = await downloadBytePlusVideo({
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
          model: normalizeOptionalString(completed.model) ?? resolvedModel,
          metadata: {
            taskId,
            status: normalizeOptionalString(completed.status),
            videoUrl,
            ratio: normalizeOptionalString(completed.ratio),
            resolution: normalizeOptionalString(completed.resolution),
            duration: readBytePlusDurationSeconds(completed.duration),
          },
        };
      } finally {
        await release();
      }
    },
  };
}
