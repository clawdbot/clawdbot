import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  createOpenAiCompatibleImageGenerationProvider,
  type ImageGenerationProvider,
  type ImageGenerationSourceImage,
  toImageDataUrl,
} from "openclaw/plugin-sdk/image-generation";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { LITELLM_BASE_URL } from "./onboard.js";

const DEFAULT_SIZE = "1024x1024";
const DEFAULT_LITELLM_IMAGE_MODEL = "gpt-image-2";
const LITELLM_SUPPORTED_SIZES = [
  "256x256",
  "512x512",
  "1024x1024",
  "1024x1536",
  "1024x1792",
  "1536x1024",
  "1792x1024",
  "2048x2048",
  "2048x1152",
  "3840x2160",
  "2160x3840",
] as const;
const LITELLM_MAX_INPUT_IMAGES = 5;

type LitellmProviderConfig = NonNullable<
  NonNullable<OpenClawConfig["models"]>["providers"]
>[string];

function resolveLitellmProviderConfig(
  cfg: OpenClawConfig | undefined,
): LitellmProviderConfig | undefined {
  return cfg?.models?.providers?.litellm;
}

function resolveConfiguredLitellmBaseUrl(cfg: OpenClawConfig | undefined): string {
  return normalizeOptionalString(resolveLitellmProviderConfig(cfg)?.baseUrl) ?? LITELLM_BASE_URL;
}

function imageToDataUrl(image: ImageGenerationSourceImage): string {
  return toImageDataUrl({ buffer: image.buffer, mimeType: image.mimeType });
}

// LiteLLM's default proxy is loopback. Auto-enable private-network access only
// for loopback-style hosts; LAN/custom private endpoints should use the
// explicit models.providers.litellm.request.allowPrivateNetwork opt-in.
function isAutoAllowedLitellmHostname(hostname: string): boolean {
  if (!hostname) {
    return false;
  }
  // Strip IPv6 brackets if any: "[::1]" -> "::1".
  const host =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const lowered = host.toLowerCase();
  if (
    lowered === "localhost" ||
    lowered === "host.docker.internal" ||
    lowered.endsWith(".localhost")
  ) {
    return true;
  }
  if (lowered === "127.0.0.1" || lowered.startsWith("127.")) {
    return true;
  }
  if (lowered === "::1" || lowered === "0:0:0:0:0:0:0:1") {
    return true;
  }
  return false;
}

function shouldAutoAllowPrivateLitellmEndpoint(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    return isAutoAllowedLitellmHostname(parsed.hostname);
  } catch {
    return false;
  }
}

export function buildLitellmImageGenerationProvider(): ImageGenerationProvider {
  return createOpenAiCompatibleImageGenerationProvider({
    id: "litellm",
    label: "LiteLLM",
    defaultModel: DEFAULT_LITELLM_IMAGE_MODEL,
    models: [DEFAULT_LITELLM_IMAGE_MODEL],
    capabilities: {
      generate: {
        maxCount: 4,
        supportsSize: true,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      edit: {
        enabled: true,
        maxCount: 4,
        maxInputImages: LITELLM_MAX_INPUT_IMAGES,
        supportsSize: true,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      geometry: {
        sizes: [...LITELLM_SUPPORTED_SIZES],
      },
    },
    defaultBaseUrl: LITELLM_BASE_URL,
    resolveBaseUrl: ({ req }) => resolveConfiguredLitellmBaseUrl(req.cfg),
    resolveAllowPrivateNetwork: ({ baseUrl }) =>
      shouldAutoAllowPrivateLitellmEndpoint(baseUrl) ? true : undefined,
    useConfiguredRequest: true,
    buildGenerateRequest: ({ req, model, count }) => ({
      kind: "json",
      body: {
        model,
        prompt: req.prompt,
        n: count,
        size: req.size ?? DEFAULT_SIZE,
      },
    }),
    buildEditRequest: ({ req, inputImages, model, count }) => ({
      kind: "json",
      body: {
        model,
        prompt: req.prompt,
        n: count,
        size: req.size ?? DEFAULT_SIZE,
        images: inputImages.map((image) => ({
          image_url: imageToDataUrl(image),
        })),
      },
    }),
    missingApiKeyError: "LiteLLM API key missing",
    failureLabels: {
      generate: "LiteLLM image generation failed",
      edit: "LiteLLM image edit failed",
    },
  });
}
