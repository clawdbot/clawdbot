import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  createProviderOperationDeadline,
  fetchWithTimeoutGuarded,
  postJsonRequest,
  resolveProviderHttpRequestConfig,
  resolveProviderOperationTimeoutMs,
  sanitizeConfiguredModelProviderRequest,
  waitProviderOperationPollInterval,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationRequest,
  VideoGenerationSourceAsset,
} from "openclaw/plugin-sdk/video-generation";
import { OPENROUTER_BASE_URL } from "./provider-catalog.js";

const DEFAULT_MODEL = "google/veo-3.1-fast";
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_HTTP_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 120;
const SUPPORTED_ASPECT_RATIOS = ["16:9", "9:16"] as const;
const SUPPORTED_DURATION_SECONDS = [4, 6, 8] as const;
const SUPPORTED_RESOLUTIONS = ["720P", "1080P"] as const;

type OpenRouterVideoResponse = {
  id?: string;
  generation_id?: string | null;
  polling_url?: string;
  status?: string;
  unsigned_urls?: string[];
  error?: string | null;
  model?: string | null;
  usage?: {
    cost?: number | null;
    is_byok?: boolean;
  };
};

type OpenRouterImagePart = {
  type: "image_url";
  image_url: { url: string };
};

type OpenRouterFrameImagePart = OpenRouterImagePart & {
  frame_type: "first_frame" | "last_frame";
};
type GuardedFetchResult = Awaited<ReturnType<typeof fetchWithTimeoutGuarded>>;
type FetchGuardOptions = NonNullable<Parameters<typeof fetchWithTimeoutGuarded>[4]>;
type DispatcherPolicy = FetchGuardOptions["dispatcherPolicy"];

function toDataUrl(asset: VideoGenerationSourceAsset): string {
  if (asset.buffer) {
    const mimeType = normalizeOptionalString(asset.mimeType) ?? "image/png";
    return `data:${mimeType};base64,${asset.buffer.toString("base64")}`;
  }
  const url = normalizeOptionalString(asset.url);
  if (url) {
    return url;
  }
  throw new Error(
    "OpenRouter video generation requires image references to include a URL or buffer.",
  );
}

function toImagePart(asset: VideoGenerationSourceAsset): OpenRouterImagePart {
  return {
    type: "image_url",
    image_url: { url: toDataUrl(asset) },
  };
}

function buildImageInputs(inputImages: VideoGenerationSourceAsset[] | undefined): {
  frameImages: OpenRouterFrameImagePart[];
  inputReferences: OpenRouterImagePart[];
} {
  const frameImages: OpenRouterFrameImagePart[] = [];
  const inputReferences: OpenRouterImagePart[] = [];
  let hasFirstFrame = false;
  let hasLastFrame = false;

  for (const image of inputImages ?? []) {
    const role = normalizeOptionalString(image.role);
    if (role === "reference_image") {
      inputReferences.push(toImagePart(image));
      continue;
    }

    const frameType =
      role === "last_frame"
        ? "last_frame"
        : role === "first_frame"
          ? "first_frame"
          : hasFirstFrame
            ? "last_frame"
            : "first_frame";

    if (frameType === "first_frame" && !hasFirstFrame) {
      frameImages.push({ ...toImagePart(image), frame_type: "first_frame" });
      hasFirstFrame = true;
      continue;
    }
    if (frameType === "last_frame" && !hasLastFrame) {
      frameImages.push({ ...toImagePart(image), frame_type: "last_frame" });
      hasLastFrame = true;
      continue;
    }
    inputReferences.push(toImagePart(image));
  }

  return { frameImages, inputReferences };
}

function resolveDurationSeconds(durationSeconds: number | undefined): number | undefined {
  if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds)) {
    return undefined;
  }
  const rounded = Math.max(1, Math.round(durationSeconds));
  return SUPPORTED_DURATION_SECONDS.reduce((best, current) => {
    const currentDistance = Math.abs(current - rounded);
    const bestDistance = Math.abs(best - rounded);
    if (currentDistance < bestDistance) {
      return current;
    }
    if (currentDistance === bestDistance && current > best) {
      return current;
    }
    return best;
  });
}

function resolveResolution(resolution: VideoGenerationRequest["resolution"]): string | undefined {
  const normalized = normalizeOptionalString(resolution);
  return normalized ? normalized.toLowerCase() : undefined;
}

function buildRequestBody(req: VideoGenerationRequest, model: string): Record<string, unknown> {
  const { frameImages, inputReferences } = buildImageInputs(req.inputImages);
  const body: Record<string, unknown> = {
    model,
    prompt: req.prompt,
  };

  const duration = resolveDurationSeconds(req.durationSeconds);
  if (duration != null) {
    body.duration = duration;
  }
  const resolution = resolveResolution(req.resolution);
  if (resolution) {
    body.resolution = resolution;
  }
  const aspectRatio = normalizeOptionalString(req.aspectRatio);
  if (aspectRatio) {
    body.aspect_ratio = aspectRatio;
  }
  const size = normalizeOptionalString(req.size);
  if (size) {
    body.size = size;
  }
  if (typeof req.audio === "boolean") {
    body.generate_audio = req.audio;
  }
  if (frameImages.length > 0) {
    body.frame_images = frameImages;
  }
  if (inputReferences.length > 0) {
    body.input_references = inputReferences;
  }

  const seed = typeof req.providerOptions?.seed === "number" ? req.providerOptions.seed : undefined;
  if (seed != null) {
    body.seed = Math.trunc(seed);
  }
  const callbackUrl =
    typeof req.providerOptions?.callback_url === "string"
      ? normalizeOptionalString(req.providerOptions.callback_url)
      : undefined;
  if (callbackUrl) {
    body.callback_url = callbackUrl;
  }

  return body;
}

function isTerminalFailure(status: string | undefined): boolean {
  return status === "failed" || status === "cancelled" || status === "expired";
}

async function fetchOpenRouterJson(params: {
  url: string;
  baseUrl: string;
  headers: Headers;
  timeoutMs: number;
  allowPrivateNetwork: boolean;
  dispatcherPolicy: DispatcherPolicy;
  errorContext: string;
  auditContext: string;
}): Promise<OpenRouterVideoResponse> {
  const { response, release } = await fetchOpenRouterGet(params);
  try {
    await assertOkOrThrowHttpError(response, params.errorContext);
    return (await response.json()) as OpenRouterVideoResponse;
  } finally {
    await release();
  }
}

async function pollOpenRouterVideo(params: {
  pollingUrl: string;
  baseUrl: string;
  headers: Headers;
  timeoutMs: number;
  allowPrivateNetwork: boolean;
  dispatcherPolicy: DispatcherPolicy;
}): Promise<OpenRouterVideoResponse> {
  const deadline = createProviderOperationDeadline({
    timeoutMs: params.timeoutMs,
    label: "OpenRouter video generation",
  });

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    const payload = await fetchOpenRouterJson({
      url: params.pollingUrl,
      baseUrl: params.baseUrl,
      headers: params.headers,
      timeoutMs: resolveProviderOperationTimeoutMs({
        deadline,
        defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
      }),
      allowPrivateNetwork: params.allowPrivateNetwork,
      dispatcherPolicy: params.dispatcherPolicy,
      errorContext: "OpenRouter video status request failed",
      auditContext: "openrouter-video-status",
    });
    const status = normalizeOptionalString(payload.status);
    if (status === "completed") {
      return payload;
    }
    if (isTerminalFailure(status)) {
      throw new Error(
        normalizeOptionalString(payload.error) ?? `OpenRouter video generation ${status}`,
      );
    }
    await waitProviderOperationPollInterval({
      deadline,
      pollIntervalMs: POLL_INTERVAL_MS,
    });
  }

  throw new Error("OpenRouter video generation did not finish in time");
}

function headersForOpenRouterGet(url: string, baseUrl: string, requestHeaders: Headers): Headers {
  try {
    if (new URL(url).origin !== new URL(baseUrl).origin) {
      return new Headers();
    }
  } catch {
    return new Headers();
  }
  const headers = new Headers(requestHeaders);
  headers.delete("content-type");
  return headers;
}

async function fetchOpenRouterGet(params: {
  url: string;
  baseUrl: string;
  headers: Headers;
  timeoutMs: number;
  allowPrivateNetwork: boolean;
  dispatcherPolicy: DispatcherPolicy;
  auditContext: string;
}): Promise<GuardedFetchResult> {
  const url = resolveOpenRouterResponseUrl(params.url, params.baseUrl);
  return await fetchWithTimeoutGuarded(
    url,
    {
      method: "GET",
      headers: headersForOpenRouterGet(url, params.baseUrl, params.headers),
    },
    params.timeoutMs,
    fetch,
    {
      ...(params.allowPrivateNetwork ? { ssrfPolicy: { allowPrivateNetwork: true } } : {}),
      ...(params.dispatcherPolicy ? { dispatcherPolicy: params.dispatcherPolicy } : {}),
      auditContext: params.auditContext,
    },
  );
}

function resolveOpenRouterResponseUrl(url: string, baseUrl: string): string {
  return new URL(url, `${baseUrl}/`).href;
}

function resolveOpenRouterContentUrl(params: { baseUrl: string; jobId: string }): string {
  return new URL(`videos/${encodeURIComponent(params.jobId)}/content?index=0`, `${params.baseUrl}/`)
    .href;
}

async function downloadOpenRouterVideo(params: {
  url: string;
  baseUrl: string;
  headers: Headers;
  timeoutMs: number;
  allowPrivateNetwork: boolean;
  dispatcherPolicy: DispatcherPolicy;
}): Promise<GeneratedVideoAsset> {
  const { response, release } = await fetchOpenRouterGet({
    ...params,
    auditContext: "openrouter-video-download",
  });
  try {
    await assertOkOrThrowHttpError(response, "OpenRouter generated video download failed");
    const mimeType = normalizeOptionalString(response.headers.get("content-type")) ?? "video/mp4";
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      buffer,
      mimeType,
      fileName: `video-1.${mimeType.includes("webm") ? "webm" : "mp4"}`,
    };
  } finally {
    await release();
  }
}

export function buildOpenRouterVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: "openrouter",
    label: "OpenRouter",
    defaultModel: DEFAULT_MODEL,
    models: [DEFAULT_MODEL],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({ provider: "openrouter", agentDir }),
    capabilities: {
      providerOptions: {
        callback_url: "string",
        seed: "number",
      },
      generate: {
        maxVideos: 1,
        supportedDurationSeconds: [...SUPPORTED_DURATION_SECONDS],
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsSize: true,
        supportsAudio: true,
        aspectRatios: [...SUPPORTED_ASPECT_RATIOS],
        resolutions: [...SUPPORTED_RESOLUTIONS],
      },
      imageToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputImages: 4,
        supportedDurationSeconds: [...SUPPORTED_DURATION_SECONDS],
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsSize: true,
        supportsAudio: true,
        aspectRatios: [...SUPPORTED_ASPECT_RATIOS],
        resolutions: [...SUPPORTED_RESOLUTIONS],
      },
      videoToVideo: {
        enabled: false,
      },
    },
    async generateVideo(req) {
      if ((req.inputVideos?.length ?? 0) > 0) {
        throw new Error("OpenRouter video generation does not support video reference inputs.");
      }

      const auth = await resolveApiKeyForProvider({
        provider: "openrouter",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("OpenRouter API key missing");
      }

      const model = normalizeOptionalString(req.model) ?? DEFAULT_MODEL;
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: req.cfg?.models?.providers?.openrouter?.baseUrl,
          defaultBaseUrl: OPENROUTER_BASE_URL,
          allowPrivateNetwork: false,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://openclaw.ai",
            "X-OpenRouter-Title": "OpenClaw",
          },
          request: sanitizeConfiguredModelProviderRequest(
            req.cfg?.models?.providers?.openrouter?.request,
          ),
          provider: "openrouter",
          capability: "video",
          transport: "http",
        });
      const deadline = createProviderOperationDeadline({
        timeoutMs: req.timeoutMs,
        label: "OpenRouter video generation",
      });
      const { response, release } = await postJsonRequest({
        url: `${baseUrl}/videos`,
        headers,
        body: buildRequestBody(req, model),
        timeoutMs: resolveProviderOperationTimeoutMs({
          deadline,
          defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
        }),
        fetchFn: fetch,
        allowPrivateNetwork,
        dispatcherPolicy,
        auditContext: "openrouter-video-submit",
      });

      try {
        await assertOkOrThrowHttpError(response, "OpenRouter video generation failed");
        const submitted = (await response.json()) as OpenRouterVideoResponse;
        const jobId = normalizeOptionalString(submitted.id);
        const pollingUrl = normalizeOptionalString(submitted.polling_url);
        if (!jobId || !pollingUrl) {
          throw new Error("OpenRouter video generation response missing job details");
        }
        const completed =
          normalizeOptionalString(submitted.status) === "completed"
            ? submitted
            : await pollOpenRouterVideo({
                pollingUrl,
                baseUrl,
                headers,
                timeoutMs: resolveProviderOperationTimeoutMs({
                  deadline,
                  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
                }),
                allowPrivateNetwork,
                dispatcherPolicy,
              });
        const completedJobId = normalizeOptionalString(completed.id) ?? jobId;
        const videoUrl =
          completed.unsigned_urls?.find((url) => normalizeOptionalString(url)) ??
          resolveOpenRouterContentUrl({ baseUrl, jobId: completedJobId });
        const video = await downloadOpenRouterVideo({
          url: videoUrl,
          baseUrl,
          headers,
          timeoutMs: resolveProviderOperationTimeoutMs({
            deadline,
            defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
          }),
          allowPrivateNetwork,
          dispatcherPolicy,
        });

        return {
          videos: [video],
          model: normalizeOptionalString(completed.model) ?? model,
          metadata: {
            jobId,
            status: completed.status,
            ...(normalizeOptionalString(completed.generation_id)
              ? { generationId: normalizeOptionalString(completed.generation_id) }
              : {}),
            ...(completed.usage ? { usage: completed.usage } : {}),
          },
        };
      } finally {
        await release();
      }
    },
  };
}
