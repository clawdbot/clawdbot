import { extensionForMime } from "openclaw/plugin-sdk/media-mime";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationRequest,
} from "openclaw/plugin-sdk/video-generation";
import {
  DEEPINFRA_NATIVE_BASE_URL,
  DEEPINFRA_VIDEO_ASPECT_RATIOS,
  DEEPINFRA_VIDEO_DURATIONS,
  DEEPINFRA_VIDEO_MODELS,
  DEFAULT_DEEPINFRA_VIDEO_MODEL,
  normalizeDeepInfraBaseUrl,
  normalizeDeepInfraModelRef,
} from "./media-models.js";

type DeepInfraVideoStatus = {
  status?: string;
  runtime_ms?: number;
};

type DeepInfraVideoResponse = {
  video_url?: string;
  seed?: number;
  request_id?: string;
  inference_status?: DeepInfraVideoStatus;
};

function encodeDeepInfraModelPath(model: string): string {
  return model.split("/").map(encodeURIComponent).join("/");
}

function resolveDeepInfraNativeBaseUrl(req: VideoGenerationRequest): string {
  const providerConfig = req.cfg?.models?.providers?.deepinfra as
    | (Record<string, unknown> & { baseUrl?: unknown })
    | undefined;
  const nativeBaseUrl = normalizeOptionalString(providerConfig?.nativeBaseUrl);
  if (nativeBaseUrl) {
    return normalizeDeepInfraBaseUrl(nativeBaseUrl, DEEPINFRA_NATIVE_BASE_URL);
  }
  const configuredBaseUrl = normalizeOptionalString(providerConfig?.baseUrl);
  if (configuredBaseUrl?.includes("/v1/inference")) {
    return normalizeDeepInfraBaseUrl(configuredBaseUrl, DEEPINFRA_NATIVE_BASE_URL);
  }
  return DEEPINFRA_NATIVE_BASE_URL;
}

function normalizeDeepInfraVideoUrl(url: string): string {
  if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("data:")) {
    return url;
  }
  return new URL(url, "https://api.deepinfra.com").href;
}

function parseVideoDataUrl(url: string): GeneratedVideoAsset | undefined {
  const match = /^data:([^;,]+);base64,(.+)$/u.exec(url);
  if (!match) {
    return undefined;
  }
  const mimeType = match[1] ?? "video/mp4";
  const ext = extensionForMime(mimeType)?.slice(1) ?? "mp4";
  return {
    buffer: Buffer.from(match[2] ?? "", "base64"),
    mimeType,
    fileName: `video-1.${ext}`,
  };
}

function coerceProviderNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function coerceProviderString(value: unknown): string | undefined {
  return normalizeOptionalString(value);
}

function resolveDurationSeconds(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value <= 6.5 ? 5 : 8;
}

function buildDeepInfraVideoBody(
  req: VideoGenerationRequest,
  model: string,
): Record<string, unknown> {
  const options = req.providerOptions ?? {};
  const body: Record<string, unknown> = {
    prompt: req.prompt,
  };
  const aspectRatio = normalizeOptionalString(req.aspectRatio);
  if (aspectRatio) {
    body.aspect_ratio = aspectRatio;
  }
  const duration = resolveDurationSeconds(req.durationSeconds);
  if (duration) {
    body.duration = duration;
  }
  const seed = coerceProviderNumber(options.seed);
  if (seed != null) {
    body.seed = seed;
  }
  const negativePrompt =
    coerceProviderString(options.negative_prompt) ?? coerceProviderString(options.negativePrompt);
  if (negativePrompt) {
    body.negative_prompt = negativePrompt;
  }
  const style = coerceProviderString(options.style);
  if (style) {
    body.style = style;
  }
  const guidanceScale =
    coerceProviderNumber(options.guidance_scale) ?? coerceProviderNumber(options.guidanceScale);
  if (guidanceScale != null && model.startsWith("Wan-AI/")) {
    body.guidance_scale = guidanceScale;
  }
  return body;
}

function extractDeepInfraVideoAsset(payload: DeepInfraVideoResponse): GeneratedVideoAsset {
  const videoUrl = normalizeOptionalString(payload.video_url);
  if (!videoUrl) {
    throw new Error("DeepInfra video response missing video_url");
  }
  const normalizedUrl = normalizeDeepInfraVideoUrl(videoUrl);
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

function failureMessage(payload: DeepInfraVideoResponse): string | undefined {
  const status = normalizeOptionalString(payload.inference_status?.status)?.toLowerCase();
  if (status === "failed" || status === "error") {
    return "DeepInfra video generation failed";
  }
  return undefined;
}

export function buildDeepInfraVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: "deepinfra",
    label: "DeepInfra",
    defaultModel: DEFAULT_DEEPINFRA_VIDEO_MODEL,
    models: [...DEEPINFRA_VIDEO_MODELS],
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
          guidance_scale: "number",
          guidanceScale: "number",
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

      const model = normalizeDeepInfraModelRef(req.model, DEFAULT_DEEPINFRA_VIDEO_MODEL);
      const resolvedBaseUrl = resolveDeepInfraNativeBaseUrl(req);
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: resolvedBaseUrl,
          defaultBaseUrl: DEEPINFRA_NATIVE_BASE_URL,
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
        url: `${baseUrl}/${encodeDeepInfraModelPath(model)}`,
        headers,
        body: buildDeepInfraVideoBody(req, model),
        timeoutMs: req.timeoutMs,
        fetchFn: fetch,
        allowPrivateNetwork,
        dispatcherPolicy,
      });
      try {
        await assertOkOrThrowHttpError(response, "DeepInfra video generation failed");
        let payload: DeepInfraVideoResponse;
        try {
          payload = (await response.json()) as DeepInfraVideoResponse;
        } catch (cause) {
          throw new Error("DeepInfra video generation failed: malformed JSON response", { cause });
        }
        const failed = failureMessage(payload);
        if (failed) {
          throw new Error(failed);
        }
        const video = extractDeepInfraVideoAsset(payload);
        return {
          videos: [video],
          model,
          metadata: {
            requestId: normalizeOptionalString(payload.request_id),
            seed: payload.seed,
            status: payload.inference_status?.status,
          },
        };
      } finally {
        await release();
      }
    },
  };
}
