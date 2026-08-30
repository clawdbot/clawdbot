/** Keeps executable provider hooks off the static model-reference import graph. */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolveProviderRuntimeOwnerRefs } from "../plugins/provider-config-owner.js";
import {
  normalizeProviderModelIdWithResolvedPlugin,
  type ProviderModelIdNormalizationParams,
} from "../plugins/provider-model-normalization.js";
import {
  findProviderRuntimePluginInRegistry,
  matchesProviderRuntimePlugin,
} from "../plugins/provider-registry-shared.js";
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-state.js";

type ProviderRuntimeModule = typeof import("../plugins/provider-model-normalization.runtime.js");

const require = createRequire(import.meta.url);
let providerRuntimeModule: ProviderRuntimeModule | undefined;

function loadProviderRuntime(): ProviderRuntimeModule {
  if (!providerRuntimeModule) {
    // Source execution needs TS/tsconfig resolution; bundled chunks live at the
    // dist root and load the stable facade declared by tsdown, without source fallback.
    const filename = fileURLToPath(import.meta.url);
    const runtime = filename.endsWith(".ts")
      ? // SAFETY: tsx declares its synchronous require API at this CJS export.
        (require("tsx/cjs/api") as typeof import("tsx/cjs/api")).require(
          "../plugins/provider-model-normalization.runtime.ts",
          filename,
        )
      : require("./plugins/provider-model-normalization.runtime.js");
    // SAFETY: Both paths load the same core facade; tsdown declares its built entry.
    providerRuntimeModule = runtime as ProviderRuntimeModule;
  }
  return providerRuntimeModule;
}

/** Normalizes provider model ids through plugin runtime hooks when available. */
export function normalizeProviderModelIdWithRuntime(
  params: ProviderModelIdNormalizationParams,
): string | undefined {
  const registry = getPluginRuntimeGenerationRegistry();
  if (registry) {
    // The retained registry already owns provenance and missing hooks. Do not compare it
    // against a newer metadata packet or reopen cold activation when its selection is empty.
    const plugin = findProviderRuntimePluginInRegistry({
      registry,
      provider: params.provider,
      ownerRefs: resolveProviderRuntimeOwnerRefs(params),
    });
    return normalizeProviderModelIdWithResolvedPlugin(params, plugin);
  }
  const preparedPlugin = params.providerPlugin;
  if (
    preparedPlugin &&
    matchesProviderRuntimePlugin(
      preparedPlugin,
      params.provider,
      resolveProviderRuntimeOwnerRefs(params),
    )
  ) {
    // Setup already selected this callable owner. Other provider operands still resolve normally.
    return normalizeProviderModelIdWithResolvedPlugin(params, preparedPlugin);
  }
  return loadProviderRuntime().normalizeProviderModelIdWithPlugin(params);
}
