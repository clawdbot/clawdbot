/** Runtime-side provider discovery and provider registration resolution helpers. */
import { createLazyImportLoader } from "../shared/lazy-promise.js";

type ProviderRuntimeModule = typeof import("./provider-runtime.js");

type AugmentModelCatalogWithProviderPlugins =
  ProviderRuntimeModule["augmentModelCatalogWithProviderPlugins"];
type BuildProviderAuthDoctorHintWithPlugin =
  ProviderRuntimeModule["buildProviderAuthDoctorHintWithPlugin"];
type FormatProviderAuthProfileApiKeyWithPlugin =
  ProviderRuntimeModule["formatProviderAuthProfileApiKeyWithPlugin"];
type PrepareProviderRuntimeAuth = ProviderRuntimeModule["prepareProviderRuntimeAuth"];
type RefreshProviderOAuthCredentialWithPlugin =
  ProviderRuntimeModule["refreshProviderOAuthCredentialWithPlugin"];

const providerRuntimeLoader = createLazyImportLoader<ProviderRuntimeModule>(
  () => import("./provider-runtime.js"),
);

async function loadProviderRuntime(): Promise<ProviderRuntimeModule> {
  // Keep the heavy provider runtime behind an actual async boundary so callers
  // can import this wrapper eagerly without collapsing the lazy chunk.
  return await providerRuntimeLoader.load();
}

/** Lazily augments the model catalog with provider plugin metadata. */
export async function augmentModelCatalogWithProviderPlugins(
  ...args: Parameters<AugmentModelCatalogWithProviderPlugins>
): Promise<Awaited<ReturnType<AugmentModelCatalogWithProviderPlugins>>> {
  const runtime = await loadProviderRuntime();
  return runtime.augmentModelCatalogWithProviderPlugins(...args);
}

/** Lazily builds doctor hint text for provider auth problems. */
export async function buildProviderAuthDoctorHintWithPlugin(
  ...args: Parameters<BuildProviderAuthDoctorHintWithPlugin>
): Promise<Awaited<ReturnType<BuildProviderAuthDoctorHintWithPlugin>>> {
  const runtime = await loadProviderRuntime();
  return runtime.buildProviderAuthDoctorHintWithPlugin(...args);
}

/** Lazily formats API-key auth profile display text with provider plugin rules. */
export async function formatProviderAuthProfileApiKeyWithPlugin(
  ...args: Parameters<FormatProviderAuthProfileApiKeyWithPlugin>
): Promise<Awaited<ReturnType<FormatProviderAuthProfileApiKeyWithPlugin>>> {
  const runtime = await loadProviderRuntime();
  return runtime.formatProviderAuthProfileApiKeyWithPlugin(...args);
}

/** Lazily prepares provider runtime auth for model execution. */
export async function prepareProviderRuntimeAuth(
  ...args: Parameters<PrepareProviderRuntimeAuth>
): Promise<Awaited<ReturnType<PrepareProviderRuntimeAuth>>> {
  const runtime = await loadProviderRuntime();
  return runtime.prepareProviderRuntimeAuth(...args);
}

/** Lazily refreshes OAuth credentials through provider plugin runtime hooks. */
export async function refreshProviderOAuthCredentialWithPlugin(
  ...args: Parameters<RefreshProviderOAuthCredentialWithPlugin>
): Promise<Awaited<ReturnType<RefreshProviderOAuthCredentialWithPlugin>>> {
  const runtime = await loadProviderRuntime();
  return runtime.refreshProviderOAuthCredentialWithPlugin(...args);
}
