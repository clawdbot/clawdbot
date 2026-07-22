// Vydra provider module implements model/runtime integration.
import type { ImageGenerationProvider } from "openclaw/plugin-sdk/image-generation";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  readProviderJsonResponse,
} from "openclaw/plugin-sdk/provider-http";
import {
  DEFAULT_VYDRA_IMAGE_MODEL,
  downloadVydraAsset,
  extractVydraResultUrls,
  resolveCompletedVydraPayload,
  resolveVydraGeneratedMediaMaxBytes,
  resolveVydraResponseJobId,
  resolveVydraResponseStatus,
  resolveVydraRequestContext,
} from "./shared.js";

export function buildVydraImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: "vydra",
    label: "Vydra",
    defaultModel: DEFAULT_VYDRA_IMAGE_MODEL,
    models: [DEFAULT_VYDRA_IMAGE_MODEL],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "vydra",
        agentDir,
      }),
    capabilities: {
      generate: {
        maxCount: 1,
        supportsSize: false,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      edit: {
        enabled: false,
        maxCount: 1,
        maxInputImages: 0,
        supportsSize: false,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
    },
    async generateImage(req) {
      if ((req.inputImages?.length ?? 0) > 0) {
        throw new Error(
          "Vydra image generation currently supports text-to-image only in the bundled plugin.",
        );
      }
      if ((req.count ?? 1) > 1) {
        throw new Error("Vydra image generation supports at most one image per request.");
      }

      const { fetchFn, baseUrl, requestPolicy } = await resolveVydraRequestContext({
        cfg: req.cfg,
        agentDir: req.agentDir,
        authStore: req.authStore,
        capability: "image",
        ssrfPolicy: req.ssrfPolicy,
      });

      const model = req.model?.trim() || DEFAULT_VYDRA_IMAGE_MODEL;
      const { response, release } = await postJsonRequest({
        url: `${baseUrl}/models/${model}`,
        headers: requestPolicy.headers,
        body: {
          prompt: req.prompt,
          model: "text-to-image",
        },
        timeoutMs: req.timeoutMs,
        fetchFn,
        allowPrivateNetwork: requestPolicy.allowPrivateNetwork,
        ssrfPolicy: requestPolicy.ssrfPolicy,
        dispatcherPolicy: requestPolicy.dispatcherPolicy,
      });

      try {
        await assertOkOrThrowHttpError(response, "Vydra image generation failed");
        const submitted = await readProviderJsonResponse(response, "vydra.image-generation");
        const completedPayload = await resolveCompletedVydraPayload({
          submitted,
          baseUrl,
          timeoutMs: req.timeoutMs,
          fetchFn,
          kind: "image",
          missingJobIdMessage: "Vydra image generation response missing job id",
          requestPolicy,
        });
        const imageUrl = extractVydraResultUrls(completedPayload, "image")[0];
        if (!imageUrl) {
          throw new Error("Vydra image generation completed without an image URL");
        }
        const image = await downloadVydraAsset({
          url: imageUrl,
          kind: "image",
          timeoutMs: req.timeoutMs,
          fetchFn,
          maxBytes: resolveVydraGeneratedMediaMaxBytes({ cfg: req.cfg, kind: "image" }),
          requestPolicy,
        });
        return {
          images: [
            {
              buffer: image.buffer,
              mimeType: image.mimeType,
              fileName: image.fileName,
            },
          ],
          model,
          metadata: {
            jobId:
              resolveVydraResponseJobId(completedPayload) ?? resolveVydraResponseJobId(submitted),
            imageUrl,
            status: resolveVydraResponseStatus(completedPayload) ?? "completed",
          },
        };
      } finally {
        await release();
      }
    },
  };
}
