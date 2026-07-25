// Minimax provider module implements model/runtime integration.
import {
  resolveInlineImageJsonResponseMaxBytes,
  type ImageGenerationProvider,
} from "openclaw/plugin-sdk/image-generation";
import { canonicalizeBase64, MAX_IMAGE_BYTES } from "openclaw/plugin-sdk/media-runtime";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  readProviderJsonResponse,
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";

const DEFAULT_MINIMAX_IMAGE_BASE_URL = "https://api.minimax.io";
const CN_MINIMAX_IMAGE_BASE_URL = "https://api.minimaxi.com";
const DEFAULT_MODEL = "image-01";
const DEFAULT_OUTPUT_MIME = "image/png";
const MINIMAX_MAX_IMAGE_RESULTS = 9;
const MB = 1024 * 1024;
const MINIMAX_SUPPORTED_ASPECT_RATIOS = [
  "1:1",
  "16:9",
  "4:3",
  "3:2",
  "2:3",
  "3:4",
  "9:16",
  "21:9",
] as const;

type MinimaxImageApiResponse = {
  data?: {
    image_base64?: string[];
  };
  metadata?: {
    success_count?: number;
    failed_count?: number;
  };
  id?: string;
  base_resp?: {
    status_code?: number;
    status_msg?: string;
  };
};

function isMinimaxCnHost(value: string | undefined): boolean {
  const trimmed = value?.trim();
  if (!trimmed) {
    return false;
  }
  const candidate = /^[a-z][a-z\d+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const hostname = new URL(candidate).hostname.toLowerCase();
    return hostname === "minimaxi.com" || hostname.endsWith(".minimaxi.com");
  } catch {
    return false;
  }
}

function resolveMinimaxImageBaseUrl(
  cfg: Parameters<typeof resolveApiKeyForProvider>[0]["cfg"],
  providerId: string,
): string {
  // MiniMax image generation uses dedicated endpoints that are separate from
  // the text/chat API endpoints. First check MINIMAX_API_HOST env var,
  // then fall back to the provider's configured baseUrl to determine region.
  const apiHost = process.env.MINIMAX_API_HOST;
  if (isMinimaxCnHost(apiHost)) {
    return CN_MINIMAX_IMAGE_BASE_URL;
  }
  // CN onboarding stores region in provider config without requiring env var
  const providerBaseUrl = cfg?.models?.providers?.[providerId]?.baseUrl;
  if (isMinimaxCnHost(providerBaseUrl)) {
    return CN_MINIMAX_IMAGE_BASE_URL;
  }
  return DEFAULT_MINIMAX_IMAGE_BASE_URL;
}

function resolveGeneratedImageMaxBytes(req: {
  cfg: { agents?: { defaults?: { mediaMaxMb?: number } } };
}): number {
  const configured = req.cfg.agents?.defaults?.mediaMaxMb;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured * MB);
  }
  return MAX_IMAGE_BYTES;
}

function buildMinimaxImageProvider(providerId: string): ImageGenerationProvider {
  return {
    id: providerId,
    label: "MiniMax",
    defaultModel: DEFAULT_MODEL,
    models: [DEFAULT_MODEL],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: providerId,
        agentDir,
      }),
    capabilities: {
      generate: {
        maxCount: MINIMAX_MAX_IMAGE_RESULTS,
        supportsSize: false,
        supportsAspectRatio: true,
        supportsResolution: false,
      },
      edit: {
        enabled: true,
        maxCount: MINIMAX_MAX_IMAGE_RESULTS,
        maxInputImages: 1,
        supportsSize: false,
        supportsAspectRatio: true,
        supportsResolution: false,
      },
      geometry: {
        aspectRatios: [...MINIMAX_SUPPORTED_ASPECT_RATIOS],
      },
    },
    async generateImage(req) {
      const auth = await resolveApiKeyForProvider({
        provider: providerId,
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("MiniMax API key missing");
      }

      const baseUrl = resolveMinimaxImageBaseUrl(req.cfg, providerId);
      const {
        baseUrl: resolvedBaseUrl,
        allowPrivateNetwork,
        headers,
        dispatcherPolicy,
      } = resolveProviderHttpRequestConfig({
        baseUrl,
        defaultBaseUrl: DEFAULT_MINIMAX_IMAGE_BASE_URL,
        defaultHeaders: {
          Authorization: `Bearer ${auth.apiKey}`,
          "Content-Type": "application/json",
        },
        provider: providerId,
        capability: "image",
        transport: "http",
        request: sanitizeConfiguredModelProviderRequest(
          req.cfg.models?.providers?.[providerId]?.request,
        ),
      });

      const body: Record<string, unknown> = {
        model: req.model || DEFAULT_MODEL,
        prompt: req.prompt,
        response_format: "base64",
        n: req.count ?? 1,
      };

      if (req.aspectRatio?.trim()) {
        body.aspect_ratio = req.aspectRatio.trim();
      }

      // Map input images to subject_reference for image-to-image generation
      const ref = req.inputImages?.at(0);
      if (ref) {
        const mime = ref.mimeType || "image/jpeg";
        const dataUrl = `data:${mime};base64,${ref.buffer.toString("base64")}`;
        body.subject_reference = [{ type: "character", image_file: dataUrl }];
      }
      const { response, release } = await postJsonRequest({
        url: `${resolvedBaseUrl}/v1/image_generation`,
        headers,
        body,
        timeoutMs: req.timeoutMs,
        fetchFn: fetch,
        allowPrivateNetwork,
        ssrfPolicy: req.ssrfPolicy,
        dispatcherPolicy,
      });
      try {
        await assertOkOrThrowHttpError(response, "MiniMax image generation failed");

        const data = await readProviderJsonResponse<MinimaxImageApiResponse>(
          response,
          "minimax.image-generation",
          {
            maxBytes: resolveInlineImageJsonResponseMaxBytes(
              MINIMAX_MAX_IMAGE_RESULTS,
              resolveGeneratedImageMaxBytes(req),
            ),
          },
        );

        const baseResp = data.base_resp;
        if (baseResp && typeof baseResp.status_code === "number" && baseResp.status_code !== 0) {
          const msg = baseResp.status_msg ?? "";
          throw new Error(`MiniMax image generation API error (${baseResp.status_code}): ${msg}`);
        }

        const base64Images = data.data?.image_base64 ?? [];
        const failedCount = data.metadata?.failed_count ?? 0;

        if (base64Images.length === 0) {
          const reason =
            failedCount > 0 ? `${failedCount} image(s) failed to generate` : "no images returned";
          throw new Error(`MiniMax image generation returned no images: ${reason}`);
        }

        const images = base64Images
          .map((b64, index) => {
            if (!b64) {
              return null;
            }
            const canonicalBase64 = canonicalizeBase64(b64);
            if (!canonicalBase64) {
              throw new Error("MiniMax image generation returned malformed image base64");
            }
            return {
              buffer: Buffer.from(canonicalBase64, "base64"),
              mimeType: DEFAULT_OUTPUT_MIME,
              fileName: `image-${index + 1}.png`,
            };
          })
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

        return {
          images,
          model: req.model || DEFAULT_MODEL,
        };
      } finally {
        await release();
      }
    },
  };
}

export function buildMinimaxImageGenerationProvider(): ImageGenerationProvider {
  return buildMinimaxImageProvider("minimax");
}

export function buildMinimaxPortalImageGenerationProvider(): ImageGenerationProvider {
  return buildMinimaxImageProvider("minimax-portal");
}
