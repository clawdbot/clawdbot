/**
 * Public SDK subpath for embedding provider registration and runtime access.
 */
import {
  getEmbeddingProviderCore,
  listEmbeddingProvidersCore,
} from "../plugins/embedding-provider-runtime.js";
import { withLegacyPluginSdkResourceScope } from "./legacy-registry-resource-scope.js";
export { acquireEmbeddingProvider } from "../plugins/embedding-provider-runtime.js";

/** @deprecated Use acquireEmbeddingProvider and release after the created provider closes. */
export function getEmbeddingProvider(...args: Parameters<typeof getEmbeddingProviderCore>) {
  return withLegacyPluginSdkResourceScope(() => getEmbeddingProviderCore(...args));
}

/** @deprecated Use explicit adapter acquisitions for each provider lifetime. */
export function listEmbeddingProviders(...args: Parameters<typeof listEmbeddingProvidersCore>) {
  return withLegacyPluginSdkResourceScope(() => listEmbeddingProvidersCore(...args));
}

export type {
  EmbeddingInput,
  EmbeddingProvider,
  EmbeddingProviderAdapter,
  EmbeddingProviderCallOptions,
  EmbeddingProviderCreateOptions,
  EmbeddingProviderCreateResult,
  EmbeddingProviderIndexIdentity,
  EmbeddingProviderRuntime,
} from "../plugins/embedding-providers.js";
