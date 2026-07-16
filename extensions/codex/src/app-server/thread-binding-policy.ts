import type { CodexAppServerRuntimeOptions } from "./config.js";
import { normalizeCodexDynamicToolName } from "./dynamic-tool-profile.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";
import type {
  CodexPluginThreadConfigProvider,
  CodexStartOrResumeThreadParams,
} from "./thread-lifecycle-types.js";

export function shouldRotateCodexAppServerBindingForRuntime(params: {
  connectionClass: CodexAppServerRuntimeOptions["connectionClass"];
  current?: string;
  binding?: string;
}): boolean {
  if (!params.current) {
    return false;
  }
  if (params.binding === params.current) {
    return false;
  }
  return params.connectionClass === "remote" || Boolean(params.binding);
}

type CodexGpt56MultiAgentVersion = "v1" | "v2";

function resolveCodexGpt56MultiAgentVersion(
  modelRef: string | undefined,
): CodexGpt56MultiAgentVersion | undefined {
  let modelId = modelRef?.trim().toLowerCase();
  if (!modelId) {
    return undefined;
  }
  const slashIndex = modelId.indexOf("/");
  if (slashIndex > 0) {
    const provider = modelId.slice(0, slashIndex);
    if (provider !== "openai" && provider !== "codex") {
      return undefined;
    }
    modelId = modelId.slice(slashIndex + 1);
  }
  if (modelId === "gpt-5.6-sol" || modelId === "gpt-5.6-terra") {
    return "v2";
  }
  return modelId === "gpt-5.6-luna" ? "v1" : undefined;
}

export function shouldRotateCodexGpt56MultiAgentBinding(params: {
  bindingModel?: string;
  requestedModel: string;
}): boolean {
  const bindingVersion = resolveCodexGpt56MultiAgentVersion(params.bindingModel);
  const requestedVersion = resolveCodexGpt56MultiAgentVersion(params.requestedModel);
  return Boolean(bindingVersion && requestedVersion && bindingVersion !== requestedVersion);
}

export function isTransientWebSearchRestriction(
  params: Pick<
    CodexStartOrResumeThreadParams,
    | "params"
    | "nativeCodeModeEnabled"
    | "nativeProviderWebSearchSupport"
    | "persistentWebSearchAllowed"
    | "webSearchAllowed"
  >,
): boolean {
  if (params.nativeProviderWebSearchSupport === "unknown") {
    return true;
  }
  if (params.params.config?.tools?.web?.search?.enabled === false) {
    return false;
  }
  if (params.params.disableTools === true) {
    return true;
  }
  const persistentWebSearchRestriction =
    params.webSearchAllowed === false && params.persistentWebSearchAllowed === false;
  if (params.nativeCodeModeEnabled === false && !persistentWebSearchRestriction) {
    return true;
  }
  if (params.webSearchAllowed !== false) {
    return false;
  }
  if (params.persistentWebSearchAllowed !== undefined) {
    return params.persistentWebSearchAllowed;
  }
  if (params.params.toolsAllow === undefined) {
    return false;
  }
  return !params.params.toolsAllow.some((name) => {
    const normalized = normalizeCodexDynamicToolName(name);
    return normalized === "*" || normalized === "web_search";
  });
}
export function shouldRecheckRecoverablePluginBinding(params: {
  binding: CodexAppServerThreadBinding;
  pluginThreadConfig?: CodexPluginThreadConfigProvider;
}): boolean {
  if (!params.pluginThreadConfig?.enabled) {
    return false;
  }
  if (
    !params.binding.pluginAppsFingerprint ||
    !params.binding.pluginAppsInputFingerprint ||
    params.binding.pluginAppsInputFingerprint !== params.pluginThreadConfig.inputFingerprint
  ) {
    return false;
  }
  const policyContext = params.binding.pluginAppPolicyContext;
  if (!policyContext) {
    return false;
  }
  const enabledPluginConfigKeys = params.pluginThreadConfig.enabledPluginConfigKeys ?? [];
  const recoverablePluginConfigKeys =
    params.pluginThreadConfig.recoverablePluginConfigKeys ?? enabledPluginConfigKeys;
  const recoverablePluginConfigKeySet = new Set(recoverablePluginConfigKeys);
  const settledPluginConfigKeys = enabledPluginConfigKeys.filter(
    (configKey) => !recoverablePluginConfigKeySet.has(configKey),
  );
  const bindingContainsSettledPlugin = settledPluginConfigKeys.some(
    (configKey) =>
      (policyContext.pluginAppIds[configKey]?.length ?? 0) > 0 ||
      Object.values(policyContext.apps).some(
        (app) => app.source !== "account" && app.configKey === configKey,
      ),
  );
  const accountAppRecoveryEnabled =
    params.pluginThreadConfig.accountAppRecoveryEnabled ?? enabledPluginConfigKeys.length === 0;
  return (
    bindingContainsSettledPlugin ||
    (accountAppRecoveryEnabled && Object.keys(policyContext.apps).length === 0) ||
    recoverablePluginConfigKeys.length > 0
  );
}
