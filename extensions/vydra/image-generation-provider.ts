// Vydra provider module implements model/runtime integration.
import type { ImageGenerationProvider } from "openclaw/plugin-sdk/image-generation";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { DEFAULT_VYDRA_IMAGE_MODEL, runVydraGeneration } from "./shared.js";

export function buildVydraImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: "vydra",
    label: "Vydra",
    defaultModel: DEFAULT_VYDRA_IMAGE_MODEL,
    models: [DEFAULT_VYDRA_IMAGE_MODEL],
    isConfigured: (ctx) => isProviderApiKeyConfigured({ provider: "vydra", ...ctx }),
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
          "Vydra image generation currently supports text-to-image only in the Vydra plugin.",
        );
      }
      if ((req.count ?? 1) > 1) {
        throw new Error("Vydra image generation supports at most one image per request.");
      }

      const model = req.model?.trim() || DEFAULT_VYDRA_IMAGE_MODEL;
      const generated = await runVydraGeneration({
        cfg: req.cfg,
        agentDir: req.agentDir,
        authStore: req.authStore,
        kind: "image",
        model,
        body: {
          prompt: req.prompt,
          model: "text-to-image",
        },
        timeoutMs: req.timeoutMs,
        ssrfPolicy: req.ssrfPolicy,
      });
      return {
        images: [generated.asset],
        model,
        metadata: {
          jobId: generated.jobId,
          imageUrl: generated.resultUrl,
          status: generated.status,
        },
      };
    },
  };
}
