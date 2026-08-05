/** Client-scoped Codex auth and account observers. */
import { refreshCodexAppServerAuthTokens } from "./auth-bridge.js";
import type { CodexAppServerClient } from "./client.js";
import type { JsonValue } from "./protocol.js";
import { mergeCodexRateLimitsUpdate } from "./rate-limit-cache.js";
import type { CodexAppServerAuthProfileLookup } from "./session-binding.js";

type ClientRuntimeContext = Omit<CodexAppServerAuthProfileLookup, "agentDir"> & {
  agentDir: string;
  authMode?: "prepared-api-key" | "profile";
};

type ClientRuntime = {
  context: ClientRuntimeContext;
  retainedThreadId?: string;
  retainedThreadConfigFingerprint?: string;
  retainedThreadRelease?: Promise<void>;
};

const configuredClients = new WeakMap<CodexAppServerClient, ClientRuntime>();

/** Installs one auth-refresh handler and one rate-limit observer per physical client. */
export function ensureCodexAppServerClientRuntime(
  client: CodexAppServerClient,
  context: ClientRuntimeContext,
): void {
  const existing = configuredClients.get(client);
  if (existing) {
    // Shared-client keys already isolate agent/auth identity. Keep config fresh
    // without installing another physical-client handler set.
    existing.context = context;
    return;
  }
  const runtime: ClientRuntime = { context };
  configuredClients.set(client, runtime);
  client.addRequestHandler(async (request) => {
    if (request.method !== "account/chatgptAuthTokens/refresh") {
      return undefined;
    }
    if (runtime.context.authMode === "prepared-api-key") {
      throw new Error("ChatGPT token refresh is unavailable for prepared Codex API-key auth.");
    }
    return (await refreshCodexAppServerAuthTokens({
      agentDir: runtime.context.agentDir,
      authProfileId: runtime.context.authProfileId,
      ...(runtime.context.authProfileStore
        ? { authProfileStore: runtime.context.authProfileStore }
        : {}),
      config: runtime.context.config,
    })) as unknown as JsonValue;
  });
  client.addNotificationHandler((notification) => {
    if (notification.method === "account/rateLimits/updated") {
      mergeCodexRateLimitsUpdate(client, notification.params);
    }
  });
}

/** Keep at most one idle, still-subscribed thread on a physical Codex client. */
export async function retainCodexAppServerLiveThread(
  client: CodexAppServerClient,
  threadId: string,
  releasePreviousThread?: (previousThreadId: string) => Promise<void>,
  configFingerprint?: string,
): Promise<{ previousThreadId?: string } | undefined> {
  const runtime = configuredClients.get(client);
  if (!runtime) {
    return undefined;
  }
  if (runtime.retainedThreadRelease) {
    await runtime.retainedThreadRelease;
  }
  const previousThreadId = runtime.retainedThreadId;
  if (previousThreadId && previousThreadId !== threadId && releasePreviousThread) {
    // Keep the old owner visible until its unsubscribe settles; concurrent
    // lifecycle acquisition must never resume a thread being released.
    const release = releasePreviousThread(previousThreadId);
    runtime.retainedThreadRelease = release;
    try {
      await release;
    } catch (error) {
      runtime.retainedThreadId = undefined;
      runtime.retainedThreadConfigFingerprint = undefined;
      throw error;
    } finally {
      if (runtime.retainedThreadRelease === release) {
        runtime.retainedThreadRelease = undefined;
      }
    }
  }
  runtime.retainedThreadId = threadId;
  runtime.retainedThreadConfigFingerprint = configFingerprint;
  return previousThreadId ? { previousThreadId } : {};
}

/** A warm turn can skip resume only when this exact subscription was retained. */
export async function consumeCodexAppServerLiveThread(
  client: CodexAppServerClient,
  threadId: string,
  configFingerprint?: string,
): Promise<boolean> {
  const runtime = configuredClients.get(client);
  if (!runtime) {
    return false;
  }
  if (runtime.retainedThreadRelease) {
    await runtime.retainedThreadRelease;
  }
  if (
    runtime.retainedThreadId !== threadId ||
    (configFingerprint !== undefined &&
      runtime.retainedThreadConfigFingerprint !== configFingerprint)
  ) {
    return false;
  }
  runtime.retainedThreadId = undefined;
  runtime.retainedThreadConfigFingerprint = undefined;
  return true;
}
