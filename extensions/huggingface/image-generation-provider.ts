import type { ImageGenerationProvider } from "openclaw/plugin-sdk/image-generation";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";

const PROVIDER_ID = "huggingface";
const HUGGINGFACE_INFERENCE_BASE_URL = "https://router.huggingface.co/hf-inference";
const DEFAULT_MODEL = "black-forest-labs/FLUX.1-schnell";
const DEFAULT_OUTPUT_MIME = "image/png";

// Text-to-image models served by the HF Inference Providers `hf-inference`
// route (https://huggingface.co/docs/inference-providers/tasks/text-to-image).
// The router returns raw image bytes for any compatible repo id, so this list
// is for discoverability/validation only — users can pass any supported repo.
// Kept to models the `hf-inference` provider actually serves (per HF provider
// mapping); other popular FLUX/Qwen image repos are routed to fal-ai/replicate
// and would 400 on this endpoint.
const HF_INFERENCE_IMAGE_MODELS = ["black-forest-labs/FLUX.1-schnell"] as const;

const HF_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

function buildEndpointUrl(baseUrl: string, model: string): string {
  if (!HF_MODEL_ID_PATTERN.test(model)) {
    throw new Error(
      `Invalid Hugging Face model id: ${model} (expected "<org>/<repo>" with letters, digits, ".", "_", "-")`,
    );
  }
  return `${baseUrl.replace(/\/+$/, "")}/models/${model}`;
}

function inferImageMimeType(response: Response): string {
  const contentType = response.headers.get("content-type")?.trim().toLowerCase();
  if (contentType?.startsWith("image/")) {
    return contentType.split(";")[0]?.trim() ?? DEFAULT_OUTPUT_MIME;
  }
  return DEFAULT_OUTPUT_MIME;
}

function inferFileExtension(mimeType: string): string {
  const subtype = mimeType.split("/")[1]?.split(";")[0]?.trim().toLowerCase() ?? "png";
  return subtype === "jpeg" ? "jpg" : subtype;
}

export function buildHuggingfaceImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: PROVIDER_ID,
    label: "Hugging Face",
    defaultModel: DEFAULT_MODEL,
    models: [...HF_INFERENCE_IMAGE_MODELS],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: PROVIDER_ID,
        agentDir,
      }),
    capabilities: {
      generate: {
        maxCount: 1,
        supportsSize: true,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      edit: {
        enabled: false,
      },
    },
    async generateImage(req) {
      if (req.inputImages && req.inputImages.length > 0) {
        throw new Error(
          "Hugging Face image generation does not support input images; use a provider with edit capability",
        );
      }
      if (typeof req.count === "number" && req.count > 1) {
        throw new Error(
          "Hugging Face image generation supports only a single image per request (count must be 1)",
        );
      }
      const auth = await resolveApiKeyForProvider({
        provider: PROVIDER_ID,
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("Hugging Face API key missing");
      }

      const model = req.model || DEFAULT_MODEL;
      const {
        baseUrl: resolvedBaseUrl,
        allowPrivateNetwork,
        headers,
        dispatcherPolicy,
      } = resolveProviderHttpRequestConfig({
        baseUrl: HUGGINGFACE_INFERENCE_BASE_URL,
        defaultBaseUrl: HUGGINGFACE_INFERENCE_BASE_URL,
        allowPrivateNetwork: false,
        defaultHeaders: {
          Authorization: `Bearer ${auth.apiKey}`,
          "Content-Type": "application/json",
          Accept: "image/*",
        },
        provider: PROVIDER_ID,
        capability: "image",
        transport: "http",
      });

      const parameters: Record<string, unknown> = {};
      if (req.size && /^\d+x\d+$/.test(req.size)) {
        const [widthStr, heightStr] = req.size.split("x");
        parameters.width = Number(widthStr);
        parameters.height = Number(heightStr);
      }

      const body: Record<string, unknown> = {
        inputs: req.prompt,
      };
      if (Object.keys(parameters).length > 0) {
        body.parameters = parameters;
      }

      const { response, release } = await postJsonRequest({
        url: buildEndpointUrl(resolvedBaseUrl, model),
        headers,
        body,
        timeoutMs: req.timeoutMs,
        fetchFn: fetch,
        allowPrivateNetwork,
        ssrfPolicy: req.ssrfPolicy,
        dispatcherPolicy,
      });
      try {
        await assertOkOrThrowHttpError(response, "Hugging Face image generation failed");

        const mimeType = inferImageMimeType(response);
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        if (buffer.length === 0) {
          throw new Error("Hugging Face image generation returned no image data");
        }

        return {
          images: [
            {
              buffer,
              mimeType,
              fileName: `image-1.${inferFileExtension(mimeType)}`,
            },
          ],
          model,
        };
      } finally {
        await release();
      }
    },
  };
}
