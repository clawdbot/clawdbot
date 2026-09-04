/** Compares provider config slices against the published runtime snapshot. */
import { resolveMergedModelProviderEntry } from "../config/model-provider-config.js";
import { hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import type { ModelProviderConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

function resolveProviderConfig(
  cfg: OpenClawConfig | undefined,
  provider: string,
): ModelProviderConfig | undefined {
  return resolveMergedModelProviderEntry(cfg, provider)?.providerConfig;
}

// Per-(config-object, provider) hash memoization. Provider-auth lifecycle
// calls repeat with the same stable config objects, and re-serializing large
// model catalogs on every call starves the event loop (#138139). Config
// objects are replaced, not mutated, on reload, so a WeakMap keyed on object
// identity invalidates structurally when the old tree is collected.
const providerConfigHashCache = new WeakMap<OpenClawConfig, Map<string, string>>();

function hashProviderComparableConfig(
  config: OpenClawConfig | undefined,
  provider: string,
): string | null {
  if (!config) {
    return null;
  }
  const providerConfig = resolveProviderConfig(config, provider);
  if (!providerConfig) {
    return null;
  }
  let hashesByProvider = providerConfigHashCache.get(config);
  if (!hashesByProvider) {
    hashesByProvider = new Map<string, string>();
    providerConfigHashCache.set(config, hashesByProvider);
  }
  const cached = hashesByProvider.get(provider);
  if (cached !== undefined) {
    return cached;
  }
  const hash = hashRuntimeConfigValue({
    models: { providers: { [provider]: providerConfig } },
  });
  hashesByProvider.set(provider, hash);
  return hash;
}

export function providerConfigMatchesRuntimeSnapshot(params: {
  inputConfig: OpenClawConfig | undefined;
  runtimeConfig: OpenClawConfig | null;
  provider: string;
}): boolean {
  const inputHash = hashProviderComparableConfig(params.inputConfig, params.provider);
  const runtimeHash = hashProviderComparableConfig(
    params.runtimeConfig ?? undefined,
    params.provider,
  );
  if (inputHash === null || runtimeHash === null) {
    return false;
  }
  return inputHash === runtimeHash;
}
