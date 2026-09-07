/** Compatibility ownership for the shipped memory-specific embedding adapter contract. */
import {
  getMemoryEmbeddingProviderCore,
  listMemoryEmbeddingProvidersCore,
  listRegisteredMemoryEmbeddingProviderAdaptersCore,
} from "../plugins/memory-embedding-provider-runtime.js";
import { withLegacyPluginSdkResourceScope } from "./legacy-registry-resource-scope.js";

/** @deprecated Use explicit adapter acquisitions for retained callbacks. */
export function listRegisteredMemoryEmbeddingProviderAdapters() {
  return withLegacyPluginSdkResourceScope(() =>
    listRegisteredMemoryEmbeddingProviderAdaptersCore(),
  );
}

export { acquireMemoryEmbeddingProvider } from "../plugins/memory-embedding-provider-runtime.js";

/** @deprecated Acquire an adapter and release after its created provider closes. */
export function getMemoryEmbeddingProvider(
  ...args: Parameters<typeof getMemoryEmbeddingProviderCore>
) {
  return withLegacyPluginSdkResourceScope(() => getMemoryEmbeddingProviderCore(...args));
}

/** @deprecated Use explicit adapter acquisitions for retained callbacks. */
export function listMemoryEmbeddingProviders(
  ...args: Parameters<typeof listMemoryEmbeddingProvidersCore>
) {
  return withLegacyPluginSdkResourceScope(() => listMemoryEmbeddingProvidersCore(...args));
}
