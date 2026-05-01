// Shared image-generation implementation helpers for bundled and third-party plugins.

export type { AuthProfileStore } from "../agents/auth-profiles/types.js";
export type { FallbackAttempt } from "../agents/model-fallback.types.js";
export type { ImageGenerationProviderPlugin } from "../plugins/types.js";
export type {
  GeneratedImageAsset,
  ImageGenerationProvider,
  ImageGenerationProviderConfiguredContext,
  ImageGenerationResolution,
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageGenerationSourceImage,
} from "../image-generation/types.js";
export type { OpenClawConfig } from "../config/types.openclaw.js";

export { describeFailoverError, isFailoverError } from "../agents/failover-error.js";
export {
  buildNoCapabilityModelConfiguredMessage,
  resolveCapabilityModelCandidates,
  throwCapabilityGenerationFailure,
} from "../media-generation/runtime-shared.js";
export {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
export { parseGeminiAuth } from "../infra/gemini-auth.js";
export {
  getImageGenerationProvider,
  listImageGenerationProviders,
} from "../image-generation/provider-registry.js";
export { parseImageGenerationModelRef } from "../image-generation/model-ref.js";
export { createSubsystemLogger } from "../logging/subsystem.js";
export { normalizeGooglePreviewModelId as normalizeGoogleModelId } from "./provider-model-shared.js";
export { getProviderEnvVars } from "../secrets/provider-env-vars.js";
export const OPENAI_DEFAULT_IMAGE_MODEL = "gpt-image-2";

type ImageGenerationCoreAuthRuntimeModule =
  typeof import("./image-generation-core.auth.runtime.js");

let imageGenerationCoreAuthRuntimePromise:
  | Promise<ImageGenerationCoreAuthRuntimeModule>
  | undefined;

async function loadImageGenerationCoreAuthRuntime(): Promise<ImageGenerationCoreAuthRuntimeModule> {
  imageGenerationCoreAuthRuntimePromise ??= import("./image-generation-core.auth.runtime.js");
  return imageGenerationCoreAuthRuntimePromise;
}

export async function resolveApiKeyForProvider(
  ...args: Parameters<ImageGenerationCoreAuthRuntimeModule["resolveApiKeyForProvider"]>
): Promise<Awaited<ReturnType<ImageGenerationCoreAuthRuntimeModule["resolveApiKeyForProvider"]>>> {
  const runtime = await loadImageGenerationCoreAuthRuntime();
  return runtime.resolveApiKeyForProvider(...args);
}
