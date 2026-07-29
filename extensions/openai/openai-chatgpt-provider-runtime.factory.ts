import { ensureGlobalUndiciEnvProxyDispatcher } from "openclaw/plugin-sdk/runtime-env";
import { refreshOpenAICodexToken as refreshOpenAICodexTokenFromFlow } from "./openai-chatgpt-oauth-flow.runtime.js";

type OpenAICodexProviderRuntimeDeps = {
  ensureGlobalUndiciEnvProxyDispatcher: typeof ensureGlobalUndiciEnvProxyDispatcher;
  refreshOpenAICodexToken: typeof refreshOpenAICodexTokenFromFlow;
};

export function createOpenAICodexProviderRuntime(deps: OpenAICodexProviderRuntimeDeps): {
  refreshOpenAICodexToken: typeof refreshOpenAICodexTokenFromFlow;
} {
  return {
    async refreshOpenAICodexToken(...args) {
      deps.ensureGlobalUndiciEnvProxyDispatcher();
      return await deps.refreshOpenAICodexToken(...args);
    },
  };
}
