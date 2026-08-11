import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import {
  releaseLeasedSharedCodexAppServerClient,
  type CodexAppServerClientOptions,
  type CodexAppServerClientFactory,
} from "./shared-client.js";
import type { CodexNativeWebSearchSupport } from "./web-search.js";

function resolveOverriddenProviderWebSearchSupport(
  modelProviderOverride: string | undefined,
): CodexNativeWebSearchSupport | undefined {
  const provider = modelProviderOverride?.trim().toLowerCase();
  if (!provider) {
    return undefined;
  }
  // The capability RPC describes the configured provider, not a thread
  // override. OpenAI's hosted support is known; other overrides stay managed.
  return provider === "openai" ? "supported" : "unsupported";
}

async function readConfiguredProviderWebSearchSupport(params: {
  client: CodexAppServerClient;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<CodexNativeWebSearchSupport> {
  const response = await params.client.request(
    "modelProvider/capabilities/read",
    {},
    {
      timeoutMs: params.timeoutMs,
      signal: params.signal,
    },
  );
  return response.webSearch ? "supported" : "unsupported";
}

export async function resolveCodexProviderWebSearchSupportForClient(params: {
  client: CodexAppServerClient;
  timeoutMs: number;
  modelProviderOverride: string | undefined;
  signal: AbortSignal;
}): Promise<CodexNativeWebSearchSupport> {
  const overrideSupport = resolveOverriddenProviderWebSearchSupport(params.modelProviderOverride);
  if (overrideSupport) {
    return overrideSupport;
  }
  try {
    return await readConfiguredProviderWebSearchSupport(params);
  } catch {
    return "unknown";
  }
}

export async function resolveCodexProviderWebSearchSupport(params: {
  clientFactory: CodexAppServerClientFactory;
  appServer: CodexAppServerRuntimeOptions;
  authProfileId: string | null | undefined;
  preparedAuth?: CodexAppServerClientOptions["preparedAuth"];
  agentDir: string;
  config: EmbeddedRunAttemptParams["config"] | undefined;
  modelProviderOverride: string | undefined;
  signal: AbortSignal;
}): Promise<CodexNativeWebSearchSupport> {
  const overrideSupport = resolveOverriddenProviderWebSearchSupport(params.modelProviderOverride);
  if (overrideSupport) {
    // Never serialize the prewarmed app-server startup behind a capability
    // probe whose answer is already fixed by the selected thread provider.
    return overrideSupport;
  }
  let client: CodexAppServerClient | undefined;
  try {
    client = await params.clientFactory({
      startOptions: params.appServer.start,
      ...(params.preparedAuth
        ? { preparedAuth: params.preparedAuth }
        : { authProfileId: params.authProfileId }),
      agentDir: params.agentDir,
      config: params.config,
      timeoutMs: params.appServer.requestTimeoutMs,
    });
    return await resolveCodexProviderWebSearchSupportForClient({
      client,
      timeoutMs: params.appServer.requestTimeoutMs,
      modelProviderOverride: params.modelProviderOverride,
      signal: params.signal,
    });
  } catch {
    return "unknown";
  } finally {
    if (client) {
      releaseLeasedSharedCodexAppServerClient(client);
    }
  }
}
