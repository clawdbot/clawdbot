/**
 * Runtime SDK subpath for video generation provider access.
 */
import { listRuntimeVideoGenerationProvidersCore as listProvidersCore } from "../video-generation/runtime.js";
import { withLegacyPluginSdkResourceScope } from "./legacy-registry-resource-scope.js";
export {
  generateVideo,
  type GenerateVideoParams,
  type GenerateVideoRuntimeResult,
} from "../video-generation/runtime.js";

/** @deprecated Acquire provider registrations explicitly when retaining callbacks. */
export function listRuntimeVideoGenerationProviders(...args: Parameters<typeof listProvidersCore>) {
  return withLegacyPluginSdkResourceScope(() => listProvidersCore(...args));
}
