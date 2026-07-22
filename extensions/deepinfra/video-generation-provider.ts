// Deepinfra provider module implements model/runtime integration.
import { extensionForMime } from "openclaw/plugin-sdk/media-mime";
import { canonicalizeBase64 } from "openclaw/plugin-sdk/media-runtime";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  createProviderOperationDeadline,
  pollProviderOperationJson,
  postJsonRequest,
  readProviderJsonResponse,
  resolveProviderHttpRequestConfig,
  resolveProviderOperationTimeoutMs,
} from "openclaw/plugin-sdk/provider-http";
import {
  asSafeIntegerInRange,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationRequest,
} from "openclaw/plugin-sdk/video-generation";
import {
  DEEPINFRA_BASE_URL,
  DEEPINFRA_VIDEO_ASPECT_RATIOS,
  DEEPINFRA_VIDEO_DURATIONS,
  DEEPINFRA_VIDEO_FALLBACK_MODELS,
  normalizeDeepInfraBaseUrl,
  normalizeDeepInfraModelRef,
} from "./media-models.js";
import type { DeepInfraSurfaceModel } from "./provider-models.js";
import { resolveDeepInfraVideoModelCapabilities } from "./surface-model-catalogs.js";

// Per-poll request budget; the total operation budget comes from req.timeoutMs.
const DEFAULT_HTTP_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 120;

// /v1/openai/videos is async: POST returns a job, GET /{id} polls until the
// job leaves the queue. Mirrors the OpenAI Sora surface (extensions/openai).
type DeepInfraVideoStatus = "queued" | "processing" | "succeeded" | "failed";

type DeepInfraVideoJob = {
  id?: string;
  status?: DeepInfraVideoStatus;
  model?: string | null;
  data?: Array<{ url?: unknown } | null> | null;
  error?: string | null;
};

function normalizeDeepInfraVideoUrl(url: string, baseUrl: string): string {
  if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("data:")) {
    return url;
  }
  return new URL(url, baseUrl).href;
}

function parseVideoDataUrl(url: string): GeneratedVideoAsset | undefined {
  const match = /^data:([^;,]+);base64,(.+)$/u.exec(url);
  if (!match) {
    return undefined;
  }
  const mimeType = match[1] ?? "video/mp4";
  const ext = extensionForMime(mimeType)?.slice(1) ?? "mp4";
  const canonicalBase64 = canonicalizeBase64(match[2] ?? "");
  if (!canonicalBase64) {
    throw new Error("DeepInfra video response returned malformed data URL base64");
  }
  return {
    buffer: Buffer.from(canonicalBase64, "base64"),
    mimeType,
    fileName: `video-1.${ext}`,
  };
}

function resolveDurationSeconds(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value <= 6.5 ? 5 : 8;
}

function resolveSeed(value: unknown): number | undefined {
  return asSafeIntegerInRange(value, { min: 0, max: 4_294_967_295 });
}

function buildDeepInfraVideoBody(
  req: VideoGenerationRequest,
  model: string,
): Record<string, unknown> {
  const options = req.providerOptions ?? {};
  const body: Record<string, unknown> = {
    model,
    prompt: req.prompt,
  };
  const aspectRatio = normalizeOptionalString(req.aspectRatio);
  if (aspectRatio) {
    body.aspect_ratio = aspectRatio;
  }
  const duration = resolveDurationSeconds(req.durationSeconds);
  if (duration) {
    // /v1/openai/videos names the duration field `seconds` (VideoGenerationIn).
    body.seconds = duration;
  }
  const seed = resolveSeed(options.seed);
  if (seed != null) {
    body.seed = seed;
  }
  const negativePrompt =
    normalizeOptionalString(options.negative_prompt) ??
    normalizeOptionalString(options.negativePrompt);
  if (negativePrompt) {
    body.negative_prompt = negativePrompt;
  }
  const style = normalizeOptionalString(options.style);
  if (style) {
    body.style = style;
  }
  return body;
}

function firstDeepInfraVideoUrl(job: DeepInfraVideoJob): string | undefined {
  for (const entry of job.data ?? []) {
    const videoUrl = entry ? normalizeOptionalString((entry as { url?: unknown }).url) : undefined;
    if (videoUrl) {
      return videoUrl;
    }
  }
  return undefined;
}

function extractDeepInfraVideoAsset(job: DeepInfraVideoJob, baseUrl: string): GeneratedVideoAsset {
  const videoUrl = firstDeepInfraVideoUrl(job);
  if (!videoUrl) {
    throw new Error("DeepInfra video response missing video URL");
  }
  const normalizedUrl = normalizeDeepInfraVideoUrl(videoUrl, baseUrl);
  // Some models return the MP4 inline as a data: URL, others a hosted https URL.
  const dataAsset = parseVideoDataUrl(normalizedUrl);
  if (dataAsset) {
    return dataAsset;
  }
  return {
    url: normalizedUrl,
    mimeType: "video/mp4",
    fileName: "video-1.mp4",
  };
}

function resolveDeepInfraVideoBaseUrl(req: VideoGenerationRequest): string {
  const providerConfig = req.cfg?.models?.providers?.deepinfra as
    | (Record<string, unknown> & { baseUrl?: unknown })
    | undefined;
  // Canonical `baseUrl` only; legacy `nativeBaseUrl`/`/v1/inference` values are
  // migrated by `openclaw doctor --fix` (doctor-contract-api.ts), never remapped here.
  const baseUrl = normalizeDeepInfraBaseUrl(providerConfig?.baseUrl, DEEPINFRA_BASE_URL);
  // The native /v1/inference video route is retired; appending the OpenAI
  // videos path to it would target a URL no host serves, so fail closed before
  // sending anything. The message must not echo the configured URL (it may
  // carry credentials).
  if (baseUrl.includes("/v1/inference")) {
    throw new Error(
      'DeepInfra video generation requires an OpenAI-compatible endpoint, but models.providers.deepinfra.baseUrl targets the retired native /v1/inference surface. Run "openclaw doctor --fix" (api.deepinfra.com migrates automatically; custom hosts must set baseUrl to an OpenAI-compatible videos endpoint).',
    );
  }
  return baseUrl;
}

// First entry of videoGenModels is the default; rest fill the allowlist.
export function buildDeepInfraVideoGenerationProvider(options?: {
  videoGenModels?: readonly DeepInfraSurfaceModel[];
}): VideoGenerationProvider {
  const ids =
    options?.videoGenModels && options.videoGenModels.length > 0
      ? options.videoGenModels.map((model) => model.id)
      : [...DEEPINFRA_VIDEO_FALLBACK_MODELS];
  const defaultModel = ids[0] ?? DEEPINFRA_VIDEO_FALLBACK_MODELS[0];
  return {
    id: "deepinfra",
    label: "DeepInfra",
    defaultModel,
    models: ids,
    resolveModelCapabilities: resolveDeepInfraVideoModelCapabilities,
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "deepinfra",
        agentDir,
      }),
    capabilities: {
      generate: {
        maxVideos: 1,
        maxDurationSeconds: 8,
        supportedDurationSeconds: [...DEEPINFRA_VIDEO_DURATIONS],
        supportsAspectRatio: true,
        aspectRatios: [...DEEPINFRA_VIDEO_ASPECT_RATIOS],
        providerOptions: {
          seed: "number",
          negative_prompt: "string",
          negativePrompt: "string",
          style: "string",
        },
      },
      imageToVideo: {
        enabled: false,
      },
      videoToVideo: {
        enabled: false,
      },
    },
    async generateVideo(req) {
      if ((req.inputImages?.length ?? 0) > 0) {
        throw new Error("DeepInfra video generation currently supports text-to-video only.");
      }
      if ((req.inputVideos?.length ?? 0) > 0) {
        throw new Error("DeepInfra video generation does not support video reference inputs.");
      }
      const auth = await resolveApiKeyForProvider({
        provider: "deepinfra",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("DeepInfra API key missing");
      }

      const model = normalizeDeepInfraModelRef(req.model, defaultModel);
      const deadline = createProviderOperationDeadline({
        timeoutMs: req.timeoutMs,
        label: "DeepInfra video generation",
      });
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: resolveDeepInfraVideoBaseUrl(req),
          defaultBaseUrl: DEEPINFRA_BASE_URL,
          allowPrivateNetwork: false,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
            "Content-Type": "application/json",
          },
          provider: "deepinfra",
          capability: "video",
          transport: "http",
        });

      const { response, release } = await postJsonRequest({
        url: `${baseUrl}/videos`,
        headers,
        body: buildDeepInfraVideoBody(req, model),
        timeoutMs: resolveProviderOperationTimeoutMs({
          deadline,
          defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
        }),
        fetchFn: fetch,
        allowPrivateNetwork,
        dispatcherPolicy,
      });
      let submitted: DeepInfraVideoJob;
      try {
        await assertOkOrThrowHttpError(response, "DeepInfra video generation failed");
        submitted = await readProviderJsonResponse<DeepInfraVideoJob>(
          response,
          "DeepInfra video generation failed",
        );
      } finally {
        await release();
      }

      const jobId = normalizeOptionalString(submitted.id);
      if (!jobId) {
        throw new Error("DeepInfra video generation response missing job id");
      }
      if (submitted.status === "failed") {
        throw new Error(
          normalizeOptionalString(submitted.error) ?? "DeepInfra video generation failed",
        );
      }

      const completed =
        submitted.status === "succeeded"
          ? submitted
          : await pollProviderOperationJson<DeepInfraVideoJob>({
              url: `${baseUrl}/videos/${encodeURIComponent(jobId)}`,
              headers,
              deadline,
              defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
              fetchFn: fetch,
              maxAttempts: MAX_POLL_ATTEMPTS,
              pollIntervalMs: POLL_INTERVAL_MS,
              requestFailedMessage: "DeepInfra video status request failed",
              timeoutMessage: `DeepInfra video generation job ${jobId} did not finish in time`,
              allowPrivateNetwork,
              dispatcherPolicy,
              auditContext: "deepinfra-video-status",
              isComplete: (payload) => payload.status === "succeeded",
              getFailureMessage: (payload) =>
                payload.status === "failed"
                  ? (normalizeOptionalString(payload.error) ?? "DeepInfra video generation failed")
                  : undefined,
            });

      const video = extractDeepInfraVideoAsset(completed, baseUrl);
      return {
        videos: [video],
        model: normalizeOptionalString(completed.model) ?? model,
        metadata: {
          jobId,
          status: completed.status,
        },
      };
    },
  };
}
