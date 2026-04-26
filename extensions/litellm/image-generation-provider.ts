import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ImageGenerationProvider } from "openclaw/plugin-sdk/image-generation";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { LITELLM_BASE_URL } from "./onboard.js";

const DEFAULT_OUTPUT_MIME = "image/png";
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

function toDataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

type LitellmImageApiResponse = {
  data?: Array<{
    b64_json?: string;
    revised_prompt?: string;
  }>;
};

export function buildLitellmImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: "litellm",
    label: "LiteLLM",
    defaultModel: DEFAULT_LITELLM_IMAGE_MODEL,
    models: [DEFAULT_LITELLM_IMAGE_MODEL],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "litellm",
        agentDir,
      }),
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
    async generateImage(req) {
      const inputImages = req.inputImages ?? [];
      const isEdit = inputImages.length > 0;
      const auth = await resolveApiKeyForProvider({
        provider: "litellm",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("LiteLLM API key missing");
      }
      const providerConfig = resolveLitellmProviderConfig(req.cfg);
      const resolvedBaseUrl = resolveConfiguredLitellmBaseUrl(req.cfg);
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: resolvedBaseUrl,
          defaultBaseUrl: LITELLM_BASE_URL,
          allowPrivateNetwork: shouldAutoAllowPrivateLitellmEndpoint(resolvedBaseUrl)
            ? true
            : undefined,
          request: sanitizeConfiguredModelProviderRequest(providerConfig?.request),
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
          },
          provider: "litellm",
          capability: "image",
          transport: "http",
        });

      const model = req.model || DEFAULT_LITELLM_IMAGE_MODEL;
      const count = req.count ?? 1;
      const size = req.size ?? DEFAULT_SIZE;

      const jsonHeaders = new Headers(headers);
      jsonHeaders.set("Content-Type", "application/json");
      const endpoint = isEdit ? "images/edits" : "images/generations";
      const body = isEdit
        ? {
            model,
            prompt: req.prompt,
            n: count,
            size,
            images: inputImages.map((image) => ({
              image_url: toDataUrl(image.buffer, image.mimeType?.trim() || DEFAULT_OUTPUT_MIME),
            })),
          }
        : {
            model,
            prompt: req.prompt,
            n: count,
            size,
          };
      const { response, release } = await postJsonRequest({
        url: `${baseUrl}/${endpoint}`,
        headers: jsonHeaders,
        body,
        timeoutMs: req.timeoutMs,
        fetchFn: fetch,
        allowPrivateNetwork,
        dispatcherPolicy,
      });
      try {
        await assertOkOrThrowHttpError(
          response,
          isEdit ? "LiteLLM image edit failed" : "LiteLLM image generation failed",
        );

        const data = (await response.json()) as LitellmImageApiResponse;
        const images = (data.data ?? [])
          .map((entry, index) => {
            if (!entry.b64_json) {
              return null;
            }
            return Object.assign(
              {
                buffer: Buffer.from(entry.b64_json, `base64`),
                mimeType: DEFAULT_OUTPUT_MIME,
                fileName: `image-${index + 1}.png`,
              },
              entry.revised_prompt ? { revisedPrompt: entry.revised_prompt } : {},
            );
          })
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

        return {
          images,
          model,
        };
      } finally {
        await release();
      }
    },
  };
}
