import type {
  GeneratedImageAsset,
  ImageGenerationProvider,
  ImageGenerationRequest,
  ImageGenerationResult,
} from "openclaw/plugin-sdk/image-generation";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  createProviderOperationDeadline,
  postJsonRequest,
  resolveProviderHttpRequestConfig,
  resolveProviderOperationTimeoutMs,
} from "openclaw/plugin-sdk/provider-http";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { XAI_BASE_URL, XAI_DEFAULT_IMAGE_MODEL, XAI_IMAGE_MODELS } from "./model-definitions.js";

const DEFAULT_OUTPUT_MIME = "image/png";
const DEFAULT_TIMEOUT_MS = 60_000;

const XAI_SUPPORTED_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "2:3", "3:2"] as const;

type XaiImageApiResponse = {
  data?: Array<{
    b64_json?: string;
    mime_type?: string;
    revised_prompt?: string;
  }>;
};

function toDataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function resolveImageForEdit(
  input: { url?: string; buffer?: Buffer; mimeType?: string } | undefined,
): string {
  if (!input) {
    throw new Error("xAI image edit requires an input image.");
  }
  const url = normalizeOptionalString(input.url);
  if (url) {
    return url;
  }
  if (!input.buffer) {
    throw new Error("xAI image edit input is missing both URL and buffer data.");
  }
  const mime = normalizeOptionalString(input.mimeType) ?? "image/png";
  return toDataUrl(input.buffer, mime);
}

function isEdit(req: ImageGenerationRequest): boolean {
  return (req.inputImages?.length ?? 0) > 0;
}

function resolveXaiImageBaseUrl(req: ImageGenerationRequest): string {
  return normalizeOptionalString(req.cfg?.models?.providers?.xai?.baseUrl) ?? XAI_BASE_URL;
}

function buildBody(req: ImageGenerationRequest, edit: boolean): Record<string, unknown> {
  const model = normalizeOptionalString(req.model) ?? XAI_DEFAULT_IMAGE_MODEL;
  const count = req.count ?? 1;
  const body: Record<string, unknown> = {
    model,
    prompt: req.prompt,
    n: Math.min(count, 4),
    response_format: "b64_json" as const,
  };

  const aspect = normalizeOptionalString(req.aspectRatio);
  if (aspect && (XAI_SUPPORTED_ASPECT_RATIOS as readonly string[]).includes(aspect)) {
    body.aspect_ratio = aspect;
  }

  const resolution = normalizeOptionalLowercaseString(req.resolution);
  if (resolution) {
    body.resolution = resolution;
  }

  if (edit) {
    const inputImages = req.inputImages ?? [];
    if (inputImages.length > 1) {
      body.images = inputImages.map((input) => ({
        url: resolveImageForEdit(input),
        type: "image_url",
      }));
    } else {
      body.image = {
        url: resolveImageForEdit(inputImages[0]),
        type: "image_url",
      };
    }
  }

  return body;
}

export function buildXaiImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: "xai",
    label: "xAI",
    defaultModel: XAI_DEFAULT_IMAGE_MODEL,
    models: [...XAI_IMAGE_MODELS],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "xai",
        agentDir,
      }),
    capabilities: {
      generate: {
        maxCount: 4,
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsSize: false,
      },
      edit: {
        enabled: true,
        maxCount: 4,
        maxInputImages: 5,
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsSize: false,
      },
      geometry: {
        aspectRatios: [...XAI_SUPPORTED_ASPECT_RATIOS],
        resolutions: ["1K", "2K"],
      },
    },
    async generateImage(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
      const edit = isEdit(req);
      const auth = await resolveApiKeyForProvider({
        provider: "xai",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("xAI API key missing");
      }

      const fetchFn = fetch;
      const deadline = createProviderOperationDeadline({
        timeoutMs: req.timeoutMs,
        label: edit ? "xAI image edit" : "xAI image generation",
      });
      const {
        baseUrl: resolvedBaseUrl,
        allowPrivateNetwork,
        headers,
        dispatcherPolicy,
      } = resolveProviderHttpRequestConfig({
        baseUrl: resolveXaiImageBaseUrl(req),
        defaultBaseUrl: XAI_BASE_URL,
        allowPrivateNetwork: false,
        defaultHeaders: {
          Authorization: `Bearer ${auth.apiKey}`,
          "Content-Type": "application/json",
        },
        provider: "xai",
        capability: "image",
        transport: "http",
      });

      const body = buildBody(req, edit);
      const endpoint = edit ? "/images/edits" : "/images/generations";
      const { response, release } = await postJsonRequest({
        url: `${resolvedBaseUrl}${endpoint}`,
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
        await assertOkOrThrowHttpError(
          response,
          edit ? "xAI image edit failed" : "xAI image generation failed",
        );

        const payload = (await response.json()) as XaiImageApiResponse;
        const images: GeneratedImageAsset[] = (payload.data ?? []).flatMap((item, idx) => {
          if (!item) {
            return [];
          }
          const b64 = normalizeOptionalString(item.b64_json);
          if (!b64) {
            return [];
          }
          const mimeType = normalizeOptionalString(item.mime_type) ?? DEFAULT_OUTPUT_MIME;
          return [
            {
              buffer: Buffer.from(b64, "base64"),
              mimeType,
              fileName: `image-${idx + 1}.${mimeType.split("/")[1] || "png"}`,
              ...(item.revised_prompt
                ? { revisedPrompt: normalizeOptionalString(item.revised_prompt) }
                : {}),
            },
          ];
        });

        return {
          images,
          model: normalizeOptionalString(req.model) ?? XAI_DEFAULT_IMAGE_MODEL,
        };
      } finally {
        await release();
      }
    },
  };
}
