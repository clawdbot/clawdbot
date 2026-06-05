/**
 * Filters provider/model refs for model picker visibility.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listCliRuntimeProviderIds } from "./cli-backends.js";
import { isCliRuntimeProvider } from "./model-runtime-aliases.js";

// Retired provider ids and CLI runtime aliases are implementation surfaces, not
// model picker choices. Hide them while keeping real provider/model refs visible.
const RETIRED_MODEL_PICKER_PROVIDERS = new Set(["codex", "codex-cli"]);

/** Creates a provider visibility predicate for model picker rendering. */
export function createModelPickerVisibleProviderPredicate(
  params: { config?: OpenClawConfig; env?: NodeJS.ProcessEnv; includeSetupRegistry?: boolean } = {},
): (provider: string) => boolean {
  const cliRuntimeProviders = new Set(
    listCliRuntimeProviderIds({
      config: params.config,
      env: params.env,
      includeSetupRegistry: params.includeSetupRegistry ?? false,
    }),
  );
  return (provider: string): boolean => {
    const normalized = normalizeProviderId(provider);
    return !RETIRED_MODEL_PICKER_PROVIDERS.has(normalized) && !cliRuntimeProviders.has(normalized);
  };
}

/** Returns whether a provider id should appear in the model picker. */
export function isModelPickerVisibleProvider(provider: string): boolean {
  const normalized = normalizeProviderId(provider);
  return (
    !RETIRED_MODEL_PICKER_PROVIDERS.has(normalized) &&
    !isCliRuntimeProvider(normalized, { includeSetupRegistry: true })
  );
}

/** Returns whether a provider/model ref should appear in the model picker. */
export function isModelPickerVisibleModelRef(ref: string): boolean {
  const separatorIndex = ref.indexOf("/");
  if (separatorIndex <= 0) {
    return true;
  }
  return isModelPickerVisibleProvider(ref.slice(0, separatorIndex));
}
