import { ensureGlobalUndiciEnvProxyDispatcher } from "openclaw/plugin-sdk/runtime-env";
import { refreshOpenAICodexToken as refreshOpenAICodexTokenFromFlow } from "./openai-chatgpt-oauth-flow.runtime.js";
import { createOpenAICodexProviderRuntime } from "./openai-chatgpt-provider-runtime.factory.js";

const runtime = createOpenAICodexProviderRuntime({
  ensureGlobalUndiciEnvProxyDispatcher,
  refreshOpenAICodexToken: refreshOpenAICodexTokenFromFlow,
});

export async function refreshOpenAICodexToken(
  ...args: Parameters<typeof refreshOpenAICodexTokenFromFlow>
): Promise<Awaited<ReturnType<typeof refreshOpenAICodexTokenFromFlow>>> {
  return await runtime.refreshOpenAICodexToken(...args);
}
