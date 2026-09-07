import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";

export { resolveOllamaSetupDefaultBaseUrl } from "./defaults.js";
export { buildOllamaProvider } from "./provider-models.js";

type OllamaSetupRuntime = typeof import("./setup.runtime.js");

const loadOllamaSetupRuntime = createLazyRuntimeModule(() => import("./setup.runtime.js"));

export const promptAndConfigureOllama: OllamaSetupRuntime["promptAndConfigureOllama"] = async (
  ...args
) => await (await loadOllamaSetupRuntime()).promptAndConfigureOllama(...args);

export const configureOllamaNonInteractive: OllamaSetupRuntime["configureOllamaNonInteractive"] =
  async (...args) => await (await loadOllamaSetupRuntime()).configureOllamaNonInteractive(...args);

export const ensureOllamaModelPulled: OllamaSetupRuntime["ensureOllamaModelPulled"] = async (
  ...args
) => await (await loadOllamaSetupRuntime()).ensureOllamaModelPulled(...args);
