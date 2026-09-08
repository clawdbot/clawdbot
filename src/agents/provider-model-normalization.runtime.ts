/** Reads prepared provider hooks without activating plugins during model-reference parsing. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { findProviderRuntimePluginInRegistry } from "../plugins/provider-registry-selection.js";
import type { ProviderNormalizeModelIdContext } from "../plugins/provider-runtime.types.js";
import { getPluginRegistryForContext } from "../plugins/runtime/gateway-request-scope.js";
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-state.js";

/** Refines an already statically normalized model id through its provider hook. */
export function normalizeProviderModelIdWithRuntime(params: {
  provider: string;
  context: ProviderNormalizeModelIdContext;
}): string | undefined {
  // An exact generation, including an empty one, cannot borrow ambient hooks.
  const registry = getPluginRuntimeGenerationRegistry() ?? getPluginRegistryForContext();
  if (!registry) {
    return undefined;
  }
  const plugin = findProviderRuntimePluginInRegistry({
    registry,
    provider: params.provider,
    ownerRefs: [],
  });
  return normalizeOptionalString(plugin?.normalizeModelId?.(params.context));
}
