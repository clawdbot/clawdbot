import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listCliRuntimeProviderIds } from "./cli-backends.js";
import { isCliRuntimeProvider } from "./model-runtime-aliases.js";

const RETIRED_MODEL_PICKER_PROVIDERS = new Set(["codex", "codex-cli"]);

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

export function isModelPickerVisibleProvider(provider: string): boolean {
  const normalized = normalizeProviderId(provider);
  return (
    !RETIRED_MODEL_PICKER_PROVIDERS.has(normalized) &&
    !isCliRuntimeProvider(normalized, { includeSetupRegistry: true })
  );
}

export function isModelPickerVisibleModelRef(ref: string): boolean {
  const separatorIndex = ref.indexOf("/");
  if (separatorIndex <= 0) {
    return true;
  }
  return isModelPickerVisibleProvider(ref.slice(0, separatorIndex));
}
