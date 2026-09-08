/** Runtime-side provider discovery and provider registration resolution helpers. */
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { createLazyRuntimeMethodBinder } from "../shared/lazy-runtime.js";

const providerRuntimeLoader = createLazyImportLoader(() => import("./provider-runtime.js"));
// Keep the heavy provider runtime behind an actual async boundary so callers
// can import this wrapper eagerly without collapsing the lazy chunk.
const bindProviderRuntime = createLazyRuntimeMethodBinder(providerRuntimeLoader.load);

/** Lazily augments the model catalog with provider plugin metadata. */
export const augmentModelCatalogWithProviderPlugins = bindProviderRuntime(
  (runtime) => runtime.augmentModelCatalogWithProviderPlugins,
);

/** Lazily builds doctor hint text for provider auth problems. */
export const buildProviderAuthDoctorHintWithPlugin = bindProviderRuntime(
  (runtime) => runtime.buildProviderAuthDoctorHintWithPlugin,
);

/** Lazily formats API-key auth profile display text with provider plugin rules. */
export const formatProviderAuthProfileApiKeyWithPlugin = bindProviderRuntime(
  (runtime) => runtime.formatProviderAuthProfileApiKeyWithPlugin,
);

/** Lazily runs the callback-based OAuth login owned by a provider plugin. */
export const loginProviderOAuthWithPlugin = bindProviderRuntime(
  (runtime) => runtime.loginProviderOAuthWithPlugin,
);

/** Lazily resolves or refreshes a session OAuth credential through its provider plugin. */
export const resolveProviderOAuthCredentialWithPlugin = bindProviderRuntime(
  (runtime) => runtime.resolveProviderOAuthCredentialWithPlugin,
);

/** Lazily prepares provider runtime auth for model execution. */
export const prepareProviderRuntimeAuth = bindProviderRuntime(
  (runtime) => runtime.prepareProviderRuntimeAuth,
);

/** Lazily refreshes OAuth credentials through provider plugin runtime hooks. */
export const refreshProviderOAuthCredentialWithPlugin = bindProviderRuntime(
  (runtime) => runtime.refreshProviderOAuthCredentialWithPlugin,
);
