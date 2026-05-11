import {
  getOAuthApiKey as getOAuthApiKeyFromPi,
  refreshOpenAICodexToken as refreshOpenAICodexTokenFromPi,
} from "@earendil-works/pi-ai/oauth";
import { ensureGlobalUndiciEnvProxyDispatcher } from "openclaw/plugin-sdk/runtime-env";

type OpenAICodexProviderRuntimeDeps = {
  ensureGlobalUndiciEnvProxyDispatcher: typeof ensureGlobalUndiciEnvProxyDispatcher;
  getOAuthApiKey: typeof getOAuthApiKeyFromPi;
  refreshOpenAICodexToken: typeof refreshOpenAICodexTokenFromPi;
};

export function createOpenAICodexProviderRuntime(deps: OpenAICodexProviderRuntimeDeps): {
  getOAuthApiKey: typeof getOAuthApiKey;
  refreshOpenAICodexToken: typeof refreshOpenAICodexToken;
} {
  return {
    async getOAuthApiKey(...args) {
      deps.ensureGlobalUndiciEnvProxyDispatcher();
      return await deps.getOAuthApiKey(...args);
    },
    async refreshOpenAICodexToken(...args) {
      deps.ensureGlobalUndiciEnvProxyDispatcher();
      return await deps.refreshOpenAICodexToken(...args);
    },
  };
}

const runtime = createOpenAICodexProviderRuntime({
  ensureGlobalUndiciEnvProxyDispatcher,
  getOAuthApiKey: getOAuthApiKeyFromPi,
  refreshOpenAICodexToken: refreshOpenAICodexTokenFromPi,
});

export async function getOAuthApiKey(
  ...args: Parameters<typeof getOAuthApiKeyFromPi>
): Promise<Awaited<ReturnType<typeof getOAuthApiKeyFromPi>>> {
  return await runtime.getOAuthApiKey(...args);
}

export async function refreshOpenAICodexToken(
  ...args: Parameters<typeof refreshOpenAICodexTokenFromPi>
): Promise<Awaited<ReturnType<typeof refreshOpenAICodexTokenFromPi>>> {
  return await runtime.refreshOpenAICodexToken(...args);
}
