// Inject store operations to avoid importing loader-backed auth facades during registration.
import { resolveAuthProfileOrder } from "../../agents/auth-profiles/order.js";
import { listProfilesForProvider } from "../../agents/auth-profiles/profile-list.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { createLazyRuntimeMethod, createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import type { PluginRuntime } from "./types.js";

const loadModelAuthRuntime = createLazyRuntimeModule(
  () => import("./runtime-model-auth.runtime.js"),
);

export function createRuntimeModelAuth({
  ensureAuthProfileStore,
  isProviderApiKeyConfigured,
}: Pick<
  PluginRuntime["modelAuth"],
  "ensureAuthProfileStore" | "isProviderApiKeyConfigured"
>): PluginRuntime["modelAuth"] {
  const getApiKeyForModel = createLazyRuntimeMethod(
    loadModelAuthRuntime,
    (runtime) => runtime.getApiKeyForModel,
  );
  const getRuntimeAuthForModel = createLazyRuntimeMethod(
    loadModelAuthRuntime,
    (runtime) => runtime.getRuntimeAuthForModelCore,
  );
  const resolveApiKeyForProvider = createLazyRuntimeMethod(
    loadModelAuthRuntime,
    (runtime) => runtime.resolveProviderRuntimeApiKey,
  );
  return {
    resolveProviderIdForAuth,
    ensureAuthProfileStore,
    resolveAuthProfileOrder,
    listProfilesForProvider,
    isProviderApiKeyConfigured,
    getApiKeyForModel: (params) =>
      getApiKeyForModel({
        model: params.model,
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
      }),
    getRuntimeAuthForModel: (params) =>
      getRuntimeAuthForModel({
        model: params.model,
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
      }),
    resolveApiKeyForProvider: (params) =>
      resolveApiKeyForProvider({
        provider: params.provider,
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
      }),
  };
}
