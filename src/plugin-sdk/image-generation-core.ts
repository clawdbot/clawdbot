import {
  getImageGenerationProviderCore as getProviderCore,
  listImageGenerationProvidersCore as listProvidersCore,
} from "../media-generation/registry.js";
import {
  acquirePluginCapabilityProvider,
  acquirePluginCapabilityProviders,
} from "../plugins/capability-provider-runtime.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { withLegacyPluginSdkResourceScope } from "./legacy-registry-resource-scope.js";

// Shared image-generation implementation helpers for bundled and third-party plugins.

export type { AuthProfileStore } from "../agents/auth-profiles/types.js";
export type { FallbackAttempt } from "../agents/model-fallback.types.js";
export type { ImageGenerationProviderPlugin } from "../plugins/types.js";
export type {
  GeneratedImageAsset,
  ImageGenerationProvider,
  ImageGenerationProviderConfiguredContext,
  ImageGenerationProviderOptions,
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
export { parseImageGenerationModelRef } from "../media-generation/model-ref.js";
export { createSubsystemLogger } from "../logging/subsystem.js";
export { normalizeGooglePreviewModelId as normalizeGoogleModelId } from "./provider-model-shared.js";
export { getProviderEnvVars } from "../secrets/provider-env-vars.js";
/** Default OpenAI image model used when image-generation provider config omits one. */
export const OPENAI_DEFAULT_IMAGE_MODEL = "gpt-image-2";

type ImageGenerationCoreAuthRuntimeModule =
  typeof import("./image-generation-core.auth.runtime.js");

const loadImageGenerationCoreAuthRuntime = createLazyRuntimeModule(
  () => import("./image-generation-core.auth.runtime.js"),
);

/** Resolve image-generation provider API keys through the lazy auth runtime helper. */
export async function resolveApiKeyForProvider(
  ...args: Parameters<ImageGenerationCoreAuthRuntimeModule["resolveApiKeyForProvider"]>
): Promise<Awaited<ReturnType<ImageGenerationCoreAuthRuntimeModule["resolveApiKeyForProvider"]>>> {
  const runtime = await loadImageGenerationCoreAuthRuntime();
  return runtime.resolveApiKeyForProvider(...args);
}

/** @deprecated Use acquireImageGenerationProvider and release after all callbacks finish. */
export function getImageGenerationProvider(...args: Parameters<typeof getProviderCore>) {
  return withLegacyPluginSdkResourceScope(() => getProviderCore(...args));
}

/** @deprecated Use acquireImageGenerationProviders and release after all callbacks finish. */
export function listImageGenerationProviders(...args: Parameters<typeof listProvidersCore>) {
  return withLegacyPluginSdkResourceScope(() => listProvidersCore(...args));
}

export function acquireImageGenerationProvider(
  providerId: string,
  cfg?: Parameters<typeof listProvidersCore>[0],
) {
  return acquirePluginCapabilityProvider({ key: "imageGenerationProviders", providerId, cfg });
}

export function acquireImageGenerationProviders(
  cfg?: Parameters<typeof listProvidersCore>[0],
  additionalProviderIds?: readonly string[],
) {
  return acquirePluginCapabilityProviders({
    key: "imageGenerationProviders",
    cfg,
    additionalProviderIds,
  });
}
