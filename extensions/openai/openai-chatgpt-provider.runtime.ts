import { ensureGlobalUndiciEnvProxyDispatcher } from "openclaw/plugin-sdk/runtime-env";
import { refreshOpenAICodexToken as refreshOpenAICodexTokenFromFlow } from "./openai-chatgpt-oauth-flow.runtime.js";
import type { OAuthCredentials } from "./openai-chatgpt-oauth-types.runtime.js";

type OpenAICodexProviderRuntimeDeps = {
  ensureGlobalUndiciEnvProxyDispatcher: typeof ensureGlobalUndiciEnvProxyDispatcher;
  getOAuthApiKey: typeof getOpenAICodexOAuthApiKey;
  refreshOpenAICodexToken: typeof refreshOpenAICodexTokenFromFlow;
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
  getOAuthApiKey: getOpenAICodexOAuthApiKey,
  refreshOpenAICodexToken: refreshOpenAICodexTokenFromFlow,
});

export async function getOAuthApiKey(
  ...args: Parameters<typeof getOpenAICodexOAuthApiKey>
): Promise<Awaited<ReturnType<typeof getOpenAICodexOAuthApiKey>>> {
  return await runtime.getOAuthApiKey(...args);
}

export async function refreshOpenAICodexToken(
  ...args: Parameters<typeof refreshOpenAICodexTokenFromFlow>
): Promise<Awaited<ReturnType<typeof refreshOpenAICodexTokenFromFlow>>> {
  return await runtime.refreshOpenAICodexToken(...args);
}

async function getOpenAICodexOAuthApiKey(
  providerId: string,
  credentials: Record<string, OAuthCredentials>,
): Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null> {
  if (providerId !== "openai") {
    throw new Error(`Unknown OAuth provider: ${providerId}`);
  }
  let creds = credentials[providerId];
  if (!creds) {
    return null;
  }
  if (Date.now() >= creds.expires) {
    creds = await refreshOpenAICodexTokenFromFlow(creds.refresh);
  }
  return { newCredentials: creds, apiKey: creds.access };
}
