/**
 * Runtime SDK subpath for image generation provider access.
 */
import { listRuntimeImageGenerationProvidersCore as listProvidersCore } from "../image-generation/runtime.js";
import { withLegacyPluginSdkResourceScope } from "./legacy-registry-resource-scope.js";
export {
  generateImage,
  type GenerateImageParams,
  type GenerateImageRuntimeResult,
} from "../image-generation/runtime.js";

/** @deprecated Acquire provider registrations explicitly when retaining callbacks. */
export function listRuntimeImageGenerationProviders(...args: Parameters<typeof listProvidersCore>) {
  return withLegacyPluginSdkResourceScope(() => listProvidersCore(...args));
}
