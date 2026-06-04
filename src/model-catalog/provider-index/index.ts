// Provider-index public facade for normalized provider discovery metadata.
export { loadOpenClawProviderIndex } from "./load.js";
export { normalizeOpenClawProviderIndex } from "./normalize.js";
export type {
  OpenClawProviderIndex,
  OpenClawProviderIndexPluginInstall,
  OpenClawProviderIndexPlugin,
  OpenClawProviderIndexProviderAuthChoice,
  OpenClawProviderIndexProvider,
} from "./types.js";
