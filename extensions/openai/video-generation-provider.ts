import { extensionForMime } from "openclaw/plugin-sdk/media-mime";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  createProviderOperationDeadline,
  createProviderOperationTimeoutResolver,
  executeProviderOperationWithRetry,
  fetchProviderDownloadResponse,
  fetchWithTimeoutGuarded,
  pollProviderOperationJson,
  postJsonRequest,
  postMultipartRequest,
  resolveProviderOperationTimeoutMs,
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
  type ProviderOperationTimeoutMs,
} from "openclaw/plugin-sdk/provider-http";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationRequest,
} from "openclaw/plugin-sdk/video-generation";
import { resolveConfiguredOpenAIBaseUrl, toOpenAIDataUrl } from "./shared.js";

const DEFAULT_OPENAI_VIDEO_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_VIDEO_MODEL = "sora-2";
const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 2_500;
const MAX_POLL_ATTEMPTS = 120;
const DEFAULT_GENERATED_VIDEO_MAX_BYTES = 16 * 1024 * 1024;
const OPENAI_VIDEO_SECONDS = [4, 8, 12] as const;
const OPENAI_VIDEO_SIZES = ["720x1280", "1280x720", "1024x1792", "1792x1024"] as const;

type OpenAIVideoRequestPolicy = {
  allowPrivateNetwork: boolean;
  dispatcherPolicy?: Parameters<typeof postJsonRequest>[0]["dispatcherPolicy"];
};

type OpenAIVideoStatus = "queued" | "in_progress" | "completed" | "failed";

type OpenAIReferenceAsset = {
  kind: "image" | "video";
  file: File;
  buffer: Buffer;
  mimeType: string;
};

type OpenAIVideoResponse = {
  id?: string;
  model?: string;
  status?: OpenAIVideoStatus;
  prompt?: string | null;
  seconds?: string;
  size?: string;
  error?: {
    code?: string;
    message?: string;
  } | null;
};

function toBlobBytes(buffer: Buffer): ArrayBuffer {
  const arrayBuffer = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(arrayBuffer).set(buffer);
  return arrayBuffer;
}

function resolveDurationSeconds(durationSeconds: number | undefined): "4" | "8" | "12" | undefined {
  if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds)) {
    return undefined;
  }
  const rounded = Math.max(OPENAI_VIDEO_SECONDS[0], Math.round(durationSeconds));
  const nearest = OPENAI_VIDEO_SECONDS.reduce((best, current) =>
    Math.abs(current - rounded) < Math.abs(best - rounded) ? current : best,
  );
  return String(nearest) as "4" | "8" | "12";
}

function resolveGeneratedVideoMaxBytes(req: VideoGenerationRequest): number {
  const configured = req.cfg.agents?.defaults?.mediaMaxMb;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured * 1024 * 1024);
  }
  return DEFAULT_GENERATED_VIDEO_MAX_BYTES;
}

function resolveSize(params: {
  size?: string;
  aspectRatio?: string;
  resolution?: string;
}): (typeof OPENAI_VIDEO_SIZES)[number] | undefined {
  const explicitSize = normalizeOptionalString(params.size);
  if (
    explicitSize &&
    OPENAI_VIDEO_SIZES.includes(explicitSize as (typeof OPENAI_VIDEO_SIZES)[number])
  ) {
    return explicitSize as (typeof OPENAI_VIDEO_SIZES)[number];
  }
  switch (normalizeOptionalString(params.aspectRatio)) {
    case "9:16":
      return "720x1280";
    case "16:9":
      return "1280x720";
    case "4:7":
      return "1024x1792";
    case "7:4":
      return "1792x1024";
    default:
      break;
  }
  if (params.resolution === "1080P") {
    return "1792x1024";
  }
  return undefined;
}

function resolveReferenceAsset(req: VideoGenerationRequest): OpenAIReferenceAsset | null {
  const allAssets = [...(req.inputImages ?? []), ...(req.inputVideos ?? [])];
  if (allAssets.length === 0) {
    return null;
  }
  if (allAssets.length > 1) {
    throw new Error("OpenAI video generation supports at most one reference image or video.");
  }
  const [asset] = allAssets;
  if (!asset?.buffer) {
    throw new Error(
      "OpenAI video generation currently requires local image/video uploads for reference assets.",
    );
  }
  const kind = (req.inputVideos?.length ?? 0) > 0 ? "video" : "image";
  const mimeType =
    normalizeOptionalString(asset.mimeType) || (kind === "video" ? "video/mp4" : "image/png");
  const extension =
    extensionForMime(mimeType)?.slice(1) ?? (mimeType.startsWith("video/") ? "mp4" : "png");
  const fileName =
    normalizeOptionalString(asset.fileName) ||
    `${kind === "video" ? "reference-video" : "reference-image"}.${extension}`;
  return {
    kind,
    file: new File([toBlobBytes(asset.buffer)], fileName, { type: mimeType }),
    buffer: asset.buffer,
    mimeType,
  };
}

async function pollOpenAIVideo(
  params: {
    videoId: string;
    headers: Headers;
    timeoutMs?: number;
    baseUrl: string;
    fetchFn: typeof fetch;
  } & OpenAIVideoRequestPolicy,
): Promise<OpenAIVideoResponse> {
  const deadline = createProviderOperationDeadline({
    timeoutMs: params.timeoutMs,
    label: `OpenAI video generation task ${params.videoId}`,
  });
  return await pollProviderOperationJson<OpenAIVideoResponse>({
    url: `${params.baseUrl}/videos/${params.videoId}`,
    headers: params.headers,
    deadline,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    fetchFn: params.fetchFn,
    maxAttempts: MAX_POLL_ATTEMPTS,
    pollIntervalMs: POLL_INTERVAL_MS,
    requestFailedMessage: "OpenAI video status request failed",
    timeoutMessage: `OpenAI video generation task ${params.videoId} did not finish in time`,
    allowPrivateNetwork: params.allowPrivateNetwork,
    dispatcherPolicy: params.dispatcherPolicy,
    auditContext: "openai-video-status",
    isComplete: (payload) => payload.status === "completed",
    getFailureMessage: (payload) =>
      payload.status === "failed"
        ? normalizeOptionalString(payload.error?.message) || "OpenAI video generation failed"
        : undefined,
  });
}

function resolveOpenAIVideoDownloadTimeoutMs(timeoutMs: ProviderOperationTimeoutMs | undefined) {
  const resolved = typeof timeoutMs === "function" ? timeoutMs() : timeoutMs;
  return typeof resolved === "number" && Number.isFinite(resolved) && resolved > 0
    ? resolved
    : DEFAULT_TIMEOUT_MS;
}

async function fetchOpenAIVideoDownload(
  params: {
    url: string;
    init: RequestInit;
    timeoutMs?: ProviderOperationTimeoutMs;
    fetchFn: typeof fetch;
  } & OpenAIVideoRequestPolicy,
) {
  if (!params.allowPrivateNetwork && !params.dispatcherPolicy) {
    const response = await fetchProviderDownloadResponse({
      url: params.url,
      init: params.init,
      timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      fetchFn: params.fetchFn,
      provider: "openai",
      requestFailedMessage: "OpenAI video download failed",
    });
    return {
      response,
      release: async () => {},
    };
  }

  return await executeProviderOperationWithRetry({
    provider: "openai",
    stage: "download",
    operation: async () => {
      const result = await fetchWithTimeoutGuarded(
        params.url,
        params.init,
        resolveOpenAIVideoDownloadTimeoutMs(params.timeoutMs),
        params.fetchFn,
        {
          ...(params.allowPrivateNetwork ? { ssrfPolicy: { allowPrivateNetwork: true } } : {}),
          ...(params.dispatcherPolicy ? { dispatcherPolicy: params.dispatcherPolicy } : {}),
          auditContext: "openai-video-download",
        },
      );
      try {
        await assertOkOrThrowHttpError(result.response, "OpenAI video download failed");
        return result;
      } catch (error) {
        await result.release();
        throw error;
      }
    },
  });
}

async function downloadOpenAIVideo(
  params: {
    videoId: string;
    headers: Headers;
    timeoutMs?: ProviderOperationTimeoutMs;
    baseUrl: string;
    fetchFn: typeof fetch;
    maxBytes: number;
  } & OpenAIVideoRequestPolicy,
): Promise<GeneratedVideoAsset> {
  const url = new URL(`${params.baseUrl}/videos/${params.videoId}/content`);
  url.searchParams.set("variant", "video");
  const { response, release } = await fetchOpenAIVideoDownload({
    url: url.toString(),
    init: {
      method: "GET",
      headers: new Headers({
        ...Object.fromEntries(params.headers.entries()),
        Accept: "application/binary",
      }),
    },
    timeoutMs: params.timeoutMs,
    fetchFn: params.fetchFn,
    allowPrivateNetwork: params.allowPrivateNetwork,
    dispatcherPolicy: params.dispatcherPolicy,
  });
  try {
    const mimeType = normalizeOptionalString(response.headers.get("content-type")) ?? "video/mp4";
    const buffer = await readResponseWithLimit(response, params.maxBytes, {
      onOverflow: ({ maxBytes }) =>
        new Error(`OpenAI generated video download exceeds ${maxBytes} bytes`),
    });
    return {
      buffer,
      mimeType,
      fileName: `video-1.${extensionForMime(mimeType)?.slice(1) ?? "mp4"}`,
    };
  } finally {
    await release();
  }
}

export function buildOpenAIVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: "openai",
    label: "OpenAI",
    defaultModel: DEFAULT_OPENAI_VIDEO_MODEL,
    models: [DEFAULT_OPENAI_VIDEO_MODEL, "sora-2-pro"],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "openai",
        agentDir,
        profileTypes: ["api_key"],
      }),
    capabilities: {
      generate: {
        maxVideos: 1,
        maxDurationSeconds: 12,
        supportedDurationSeconds: OPENAI_VIDEO_SECONDS,
        supportsSize: true,
        sizes: OPENAI_VIDEO_SIZES,
      },
      imageToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputImages: 1,
        maxDurationSeconds: 12,
        supportedDurationSeconds: OPENAI_VIDEO_SECONDS,
        supportsSize: true,
        sizes: OPENAI_VIDEO_SIZES,
      },
      videoToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputVideos: 1,
      },
    },
    async generateVideo(req) {
      const auth = await resolveApiKeyForProvider({
        provider: "openai",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
        modelApi: "openai-responses",
      });
      if (!auth.apiKey || (auth.mode !== undefined && auth.mode !== "api-key")) {
        throw new Error("OpenAI API key missing");
      }

      const fetchFn = fetch;
      const deadline = createProviderOperationDeadline({
        timeoutMs: req.timeoutMs,
        label: "OpenAI video generation",
      });
      const providerConfig = req.cfg.models?.providers?.openai;
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: resolveConfiguredOpenAIBaseUrl(req.cfg),
          defaultBaseUrl: DEFAULT_OPENAI_VIDEO_BASE_URL,
          request: sanitizeConfiguredModelProviderRequest(providerConfig?.request),
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
          },
          provider: "openai",
          capability: "video",
          transport: "http",
        });

      const model = normalizeOptionalString(req.model) ?? DEFAULT_OPENAI_VIDEO_MODEL;
      const seconds = resolveDurationSeconds(req.durationSeconds);
      const size = resolveSize({
        size: req.size,
        aspectRatio: req.aspectRatio,
        resolution: req.resolution,
      });
      const referenceAsset = resolveReferenceAsset(req);
      const requestResult = referenceAsset
        ? referenceAsset.kind === "image"
          ? await (() => {
              const jsonHeaders = new Headers(headers);
              jsonHeaders.set("Content-Type", "application/json");
              return postJsonRequest({
                url: `${baseUrl}/videos`,
                headers: jsonHeaders,
                body: {
                  prompt: req.prompt,
                  model,
                  ...(seconds ? { seconds } : {}),
                  ...(size ? { size } : {}),
                  input_reference: {
                    image_url: toOpenAIDataUrl(referenceAsset.buffer, referenceAsset.mimeType),
                  },
                },
                timeoutMs: resolveProviderOperationTimeoutMs({
                  deadline,
                  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
                }),
                fetchFn,
                allowPrivateNetwork,
                dispatcherPolicy,
              });
            })()
          : await (() => {
              const form = new FormData();
              form.set("prompt", req.prompt);
              form.set("model", model);
              form.set("video", referenceAsset.file);
              const multipartHeaders = new Headers(headers);
              multipartHeaders.delete("Content-Type");
              return postMultipartRequest({
                url: `${baseUrl}/videos/edits`,
                headers: multipartHeaders,
                body: form,
                timeoutMs: resolveProviderOperationTimeoutMs({
                  deadline,
                  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
                }),
                fetchFn,
                allowPrivateNetwork,
                dispatcherPolicy,
              });
            })()
        : await (() => {
            const jsonHeaders = new Headers(headers);
            jsonHeaders.set("Content-Type", "application/json");
            return postJsonRequest({
              url: `${baseUrl}/videos`,
              headers: jsonHeaders,
              body: {
                prompt: req.prompt,
                model,
                ...(seconds ? { seconds } : {}),
                ...(size ? { size } : {}),
              },
              timeoutMs: resolveProviderOperationTimeoutMs({
                deadline,
                defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
              }),
              fetchFn,
              allowPrivateNetwork,
              dispatcherPolicy,
            });
          })();
      const { response, release } = requestResult;

      try {
        await assertOkOrThrowHttpError(response, "OpenAI video generation failed");
        const submitted = (await response.json()) as OpenAIVideoResponse;
        const videoId = normalizeOptionalString(submitted.id);
        if (!videoId) {
          throw new Error("OpenAI video generation response missing video id");
        }
        const completed = await pollOpenAIVideo({
          videoId,
          headers,
          timeoutMs: resolveProviderOperationTimeoutMs({
            deadline,
            defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
          }),
          baseUrl,
          fetchFn,
          allowPrivateNetwork,
          dispatcherPolicy,
        });
        const video = await downloadOpenAIVideo({
          videoId,
          headers,
          timeoutMs: createProviderOperationTimeoutResolver({
            deadline,
            defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
          }),
          baseUrl,
          fetchFn,
          allowPrivateNetwork,
          dispatcherPolicy,
          maxBytes: resolveGeneratedVideoMaxBytes(req),
        });
        return {
          videos: [video],
          model: completed.model ?? submitted.model ?? model,
          metadata: {
            videoId,
            status: completed.status,
            seconds: completed.seconds ?? submitted.seconds,
            size: completed.size ?? submitted.size,
          },
        };
      } finally {
        await release();
      }
    },
  };
}
