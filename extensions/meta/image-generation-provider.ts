// Meta provider module implements image-generation runtime integration.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createOpenAiCompatibleImageGenerationProvider,
  imageSourceUploadFileName,
  type ImageGenerationProvider,
} from "openclaw/plugin-sdk/image-generation";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { META_BASE_URL } from "./models.js";

const PROVIDER_ID = "meta";
const DEFAULT_SIZE = "1024x1024";
const DEFAULT_IMAGE_MIME = "image/png";
const DEFAULT_META_IMAGE_MODEL = "muse-image-1.0";

// Meta muse-image renders at these OpenAI-style sizes (square/landscape/portrait).
const META_IMAGE_SUPPORTED_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;

// muse-image edits take a single reference image on the OpenAI-compatible
// /v1/images/edits endpoint. (Conversational multi-turn editing via the
// Responses API is a session concept that does not map onto OpenClaw's
// stateless image_generate tool, so it is intentionally not modeled here — a
// reference-image edit achieves the same user outcome.)
const META_MAX_INPUT_IMAGES = 1;

type MetaProviderConfig = NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string];

function resolveMetaProviderConfig(
  cfg: OpenClawConfig | undefined,
): MetaProviderConfig | undefined {
  return cfg?.models?.providers?.meta;
}

function resolveConfiguredMetaBaseUrl(cfg: OpenClawConfig | undefined): string {
  return normalizeOptionalString(resolveMetaProviderConfig(cfg)?.baseUrl) ?? META_BASE_URL;
}

/** Builds the Meta (muse-image) OpenAI-compatible image-generation provider. */
export function buildMetaImageGenerationProvider(): ImageGenerationProvider {
  return createOpenAiCompatibleImageGenerationProvider({
    id: PROVIDER_ID,
    label: "Meta",
    defaultModel: DEFAULT_META_IMAGE_MODEL,
    models: [DEFAULT_META_IMAGE_MODEL],
    capabilities: {
      generate: {
        maxCount: 1,
        supportsSize: true,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      // muse-image supports single-reference edits through /v1/images/edits.
      edit: {
        enabled: true,
        maxCount: 1,
        maxInputImages: META_MAX_INPUT_IMAGES,
        supportsSize: true,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      geometry: {
        sizes: [...META_IMAGE_SUPPORTED_SIZES],
      },
    },
    defaultBaseUrl: META_BASE_URL,
    resolveBaseUrl: ({ req }) => resolveConfiguredMetaBaseUrl(req.cfg),
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
    // Edits use the OpenAI-compatible multipart /v1/images/edits endpoint: the
    // reference image is an uploaded file part, not a JSON field.
    buildEditRequest: ({ req, inputImages, model, count }) => {
      const form = new FormData();
      form.set("model", model);
      form.set("prompt", req.prompt);
      form.set("n", String(count));
      form.set("size", req.size ?? DEFAULT_SIZE);
      for (const [index, image] of inputImages.entries()) {
        const mimeType = normalizeOptionalString(image.mimeType) ?? DEFAULT_IMAGE_MIME;
        form.append(
          "image",
          new Blob([new Uint8Array(image.buffer)], { type: mimeType }),
          imageSourceUploadFileName({ image, index }),
        );
      }
      return { kind: "multipart", form };
    },
    response: {
      // Meta returns base64 WebP payloads under data[].b64_json.
      defaultMimeType: "image/webp",
      fileNamePrefix: "meta",
      sniffMimeType: true,
    },
    missingApiKeyError: "Meta API key missing",
    failureLabels: {
      generate: "Meta image generation failed",
      edit: "Meta image edit failed",
    },
  });
}
