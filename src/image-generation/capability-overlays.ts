// Image capability overlays merge per-model discovered capabilities into provider capabilities.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GenerateImageParams } from "./runtime-types.js";
import type { ImageGenerationProvider, ImageGenerationProviderCapabilities } from "./types.js";

// Runtime/model capability overlays let a provider refine static manifest caps
// for the selected model without rebuilding the registry.
export function mergeImageGenerationProviderCapabilities(
  base: ImageGenerationProviderCapabilities,
  overlay: ImageGenerationProviderCapabilities,
): ImageGenerationProviderCapabilities {
  return {
    generate: { ...base.generate, ...overlay.generate },
    edit: { ...base.edit, ...overlay.edit },
    ...(base.geometry || overlay.geometry
      ? { geometry: { ...base.geometry, ...overlay.geometry } }
      : {}),
    ...(base.output || overlay.output ? { output: { ...base.output, ...overlay.output } } : {}),
  };
}

export async function resolveProviderWithModelCapabilities(params: {
  provider: ImageGenerationProvider;
  providerId: string;
  model: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  authStore?: GenerateImageParams["authStore"];
  timeoutMs?: number;
  log: Pick<Console, "debug">;
}): Promise<ImageGenerationProvider> {
  if (!params.provider.resolveModelCapabilities) {
    return params.provider;
  }
  try {
    const modelCapabilities = await params.provider.resolveModelCapabilities({
      provider: params.providerId,
      model: params.model,
      cfg: params.cfg,
      agentDir: params.agentDir,
      authStore: params.authStore,
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    });
    if (!modelCapabilities) {
      return params.provider;
    }
    // Return a request-local provider copy so dynamic model caps cannot leak
    // across later requests or different model candidates.
    return {
      ...params.provider,
      capabilities: mergeImageGenerationProviderCapabilities(
        params.provider.capabilities,
        modelCapabilities,
      ),
    };
  } catch (err) {
    params.log.debug(
      `image-generation model capability lookup failed for ${params.providerId}/${params.model}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return params.provider;
  }
}
