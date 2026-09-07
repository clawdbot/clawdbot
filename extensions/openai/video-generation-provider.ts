// Openai provider module implements model/runtime integration.
import { bufferToBlobPart } from "openclaw/plugin-sdk/blob-runtime";
import { extensionForMime, type MediaKind } from "openclaw/plugin-sdk/media-mime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type {
  createProviderOperationDeadline,
  pollProviderOperationJson,
  postMultipartRequest,
  ProviderOperationTimeoutMs,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationRequest,
} from "openclaw/plugin-sdk/video-generation";
import { resolveConfiguredOpenAIBaseUrl } from "./shared.js";

const DEFAULT_OPENAI_VIDEO_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_VIDEO_MODEL = "sora-2";
const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 2_500;
const MAX_POLL_ATTEMPTS = 120;
const OPENAI_VIDEO_SECONDS = [4, 8, 12] as const;
const OPENAI_VIDEO_SIZES = ["720x1280", "1280x720", "1024x1792", "1792x1024"] as const;

type OpenAIVideoRequestPolicy = {
  allowPrivateNetwork: boolean;
  dispatcherPolicy?: Parameters<typeof postMultipartRequest>[0]["dispatcherPolicy"];
};

type OpenAIVideoStatus = "queued" | "in_progress" | "completed" | "failed";

type OpenAIReferenceAsset = {
  kind: Extract<MediaKind, "image" | "video">;
  file: File;
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

function readOpenAIVideoFailureMessage(payload: OpenAIVideoResponse): string | undefined {
  return payload.status === "failed"
    ? (normalizeOptionalString(payload.error?.message) ?? "OpenAI video generation failed")
    : undefined;
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
    file: new File([bufferToBlobPart(asset.buffer)], fileName, { type: mimeType }),
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
  operations: {
    createProviderOperationDeadline: typeof createProviderOperationDeadline;
    pollProviderOperationJson: typeof pollProviderOperationJson;
  },
): Promise<OpenAIVideoResponse> {
  const { createProviderOperationDeadline, pollProviderOperationJson } = operations;
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
    getFailureMessage: readOpenAIVideoFailureMessage,
  });
}

async function fetchOpenAIVideoDownload(
  params: {
    url: string;
    init: RequestInit;
    deadline: ReturnType<typeof createProviderOperationDeadline>;
    fetchFn: typeof fetch;
  } & OpenAIVideoRequestPolicy,
) {
  const {
    assertOkOrThrowHttpError,
    createProviderOperationTimeoutResolver,
    executeProviderOperationWithRetry,
    fetchProviderDownloadResponse,
    fetchWithTimeoutGuarded,
  } = await import("openclaw/plugin-sdk/provider-http");
  const timeoutMs = createProviderOperationTimeoutResolver({
    deadline: params.deadline,
    defaultTimeoutMs: params.deadline.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (!params.allowPrivateNetwork && !params.dispatcherPolicy) {
    const response = await fetchProviderDownloadResponse({
      url: params.url,
      init: params.init,
      deadline: params.deadline,
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
        timeoutMs(),
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
  const { downloadGeneratedVideoAsset } =
    await import("openclaw/plugin-sdk/media-generation-runtime");
  const url = new URL(`${params.baseUrl}/videos/${params.videoId}/content`);
  url.searchParams.set("variant", "video");
  return await downloadGeneratedVideoAsset({
    url: url.toString(),
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    fetchFn: params.fetchFn,
    provider: "openai",
    label: "OpenAI generated video download",
    requestFailedMessage: "OpenAI video download failed",
    maxBytes: params.maxBytes,
    validateBinaryResponse: true,
    fetchResponse: async ({ deadline }) =>
      await fetchOpenAIVideoDownload({
        url: url.toString(),
        init: {
          method: "GET",
          headers: new Headers({
            ...Object.fromEntries(params.headers.entries()),
            Accept: "application/binary",
          }),
        },
        deadline,
        fetchFn: params.fetchFn,
        allowPrivateNetwork: params.allowPrivateNetwork,
        dispatcherPolicy: params.dispatcherPolicy,
      }),
  });
}

export function buildOpenAIVideoGenerationProvider({
  isProviderApiKeyConfigured,
}: Pick<
  OpenClawPluginApi["runtime"]["modelAuth"],
  "isProviderApiKeyConfigured"
>): VideoGenerationProvider {
  return {
    id: "openai",
    label: "OpenAI",
    defaultModel: DEFAULT_OPENAI_VIDEO_MODEL,
    models: [DEFAULT_OPENAI_VIDEO_MODEL, "sora-2-pro"],
    isConfigured: (ctx) =>
      isProviderApiKeyConfigured({
        provider: "openai",
        ...ctx,
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
      const { resolveApiKeyForProvider } =
        await import("openclaw/plugin-sdk/provider-auth-runtime");
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

      const [
        {
          assertOkOrThrowHttpError,
          createProviderOperationDeadline,
          createProviderOperationTimeoutResolver,
          pollProviderOperationJson,
          postMultipartRequest,
          readProviderJsonResponse,
          resolveProviderOperationTimeoutMs,
          resolveProviderHttpRequestConfig,
          sanitizeConfiguredModelProviderRequest,
        },
        { resolveGeneratedMediaMaxBytes },
      ] = await Promise.all([
        import("openclaw/plugin-sdk/provider-http"),
        import("openclaw/plugin-sdk/media-generation-runtime"),
      ]);
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
      const isVideoEdit = referenceAsset?.kind === "video";
      const form = new FormData();
      form.set("prompt", req.prompt);
      if (isVideoEdit) {
        form.set("video", referenceAsset.file);
      } else {
        form.set("model", model);
        if (seconds) {
          form.set("seconds", seconds);
        }
        if (size) {
          form.set("size", size);
        }
        if (referenceAsset) {
          form.set("input_reference", referenceAsset.file);
        }
      }
      const multipartHeaders = new Headers(headers);
      multipartHeaders.delete("Content-Type");
      const { response, release } = await postMultipartRequest({
        url: `${baseUrl}/videos${isVideoEdit ? "/edits" : ""}`,
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

      try {
        await assertOkOrThrowHttpError(response, "OpenAI video generation failed");
        const submitted = await readProviderJsonResponse<OpenAIVideoResponse>(
          response,
          "OpenAI video generation failed",
        );
        const failureMessage = readOpenAIVideoFailureMessage(submitted);
        if (failureMessage) {
          throw new Error(failureMessage);
        }
        const videoId = normalizeOptionalString(submitted.id);
        if (!videoId) {
          throw new Error("OpenAI video generation response missing video id");
        }
        const completed =
          submitted.status === "completed"
            ? submitted
            : await pollOpenAIVideo(
                {
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
                },
                { createProviderOperationDeadline, pollProviderOperationJson },
              );
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
          maxBytes: resolveGeneratedMediaMaxBytes(req.cfg, "video"),
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
