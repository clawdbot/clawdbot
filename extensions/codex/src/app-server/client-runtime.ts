/** Client-scoped Codex auth and account observers. */
import { refreshCodexAppServerAuthTokens } from "./auth-bridge.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexServiceTier, JsonValue } from "./protocol.js";
import { mergeCodexRateLimitsUpdate } from "./rate-limit-cache.js";
import type { CodexAppServerAuthProfileLookup } from "./session-binding.js";

type ClientRuntimeContext = Omit<CodexAppServerAuthProfileLookup, "agentDir"> & {
  agentDir: string;
  authMode?: "prepared-api-key" | "profile";
};

type ClientRuntime = {
  context: ClientRuntimeContext;
  retainedThreads: Map<string, RetainedLiveThread>;
  releasingThreads: Map<string, Promise<void>>;
  protectedThreads: Map<string, number>;
  evictionTimer?: ReturnType<typeof setTimeout>;
};

type RetainedLiveThread = {
  configFingerprint?: string;
  serviceTier?: CodexServiceTier | null;
  expiresAt: number;
  release: (threadId: string) => Promise<void>;
};

export type CodexAppServerLiveThreadOwnership = {
  configFingerprint?: string;
  serviceTier?: CodexServiceTier | null;
  release: (threadId: string) => Promise<void>;
};

/** Match Codex's native grace window without retaining inactive conversations indefinitely. */
const CODEX_APP_SERVER_LIVE_THREAD_IDLE_TIMEOUT_MS = 30 * 60_000;
/** Native-child parents are active ownership, so only otherwise-idle threads count against this cap. */
const CODEX_APP_SERVER_LIVE_THREAD_MAX_IDLE = 64;

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
  const runtime: ClientRuntime = {
    context,
    retainedThreads: new Map(),
    releasingThreads: new Map(),
    protectedThreads: new Map(),
  };
  configuredClients.set(client, runtime);
  client.addCloseHandler(() => {
    if (runtime.evictionTimer) {
      clearTimeout(runtime.evictionTimer);
      runtime.evictionTimer = undefined;
    }
    runtime.retainedThreads.clear();
    runtime.protectedThreads.clear();
  });
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
      return;
    }
    if (
      notification.method === "thread/archived" ||
      notification.method === "thread/deleted" ||
      notification.method === "thread/closed"
    ) {
      const threadId = (notification.params as { threadId?: unknown } | undefined)?.threadId;
      if (typeof threadId === "string") {
        // Codex already removed server-side ownership; unsubscribing again can
        // race a replacement, so only discard this exact local idle entry.
        runtime.retainedThreads.delete(threadId);
        scheduleRetainedThreadEviction(client, runtime);
      }
    }
  });
}

function scheduleRetainedThreadEviction(
  client: CodexAppServerClient,
  runtime: ClientRuntime,
): void {
  if (runtime.evictionTimer) {
    clearTimeout(runtime.evictionTimer);
    runtime.evictionTimer = undefined;
  }
  let expiresAt = Number.POSITIVE_INFINITY;
  for (const [threadId, thread] of runtime.retainedThreads) {
    if (!runtime.protectedThreads.has(threadId)) {
      expiresAt = Math.min(expiresAt, thread.expiresAt);
    }
  }
  if (!Number.isFinite(expiresAt)) {
    return;
  }
  runtime.evictionTimer = setTimeout(
    () => {
      runtime.evictionTimer = undefined;
      void evictExpiredRetainedThreads(client, runtime).catch(() => client.close());
    },
    Math.max(0, expiresAt - Date.now()),
  );
  runtime.evictionTimer.unref?.();
}

async function releaseRetainedThread(
  client: CodexAppServerClient,
  runtime: ClientRuntime,
  threadId: string,
): Promise<boolean> {
  const pendingRelease = runtime.releasingThreads.get(threadId);
  if (pendingRelease) {
    await pendingRelease;
    return false;
  }
  const retained = runtime.retainedThreads.get(threadId);
  if (!retained) {
    return false;
  }
  runtime.retainedThreads.delete(threadId);
  scheduleRetainedThreadEviction(client, runtime);
  // Keep release ownership addressable until unsubscribe settles. Unrelated
  // conversations must stay reusable while only this thread transitions.
  const release = retained.release(threadId);
  runtime.releasingThreads.set(threadId, release);
  try {
    await release;
    return true;
  } finally {
    if (runtime.releasingThreads.get(threadId) === release) {
      runtime.releasingThreads.delete(threadId);
    }
  }
}

async function evictExpiredRetainedThreads(
  client: CodexAppServerClient,
  runtime: ClientRuntime,
): Promise<void> {
  const now = Date.now();
  for (const [threadId, thread] of runtime.retainedThreads) {
    if (thread.expiresAt <= now && !runtime.protectedThreads.has(threadId)) {
      await releaseRetainedThread(client, runtime, threadId);
    }
  }
  scheduleRetainedThreadEviction(client, runtime);
}

async function evictExcessIdleThreads(
  client: CodexAppServerClient,
  runtime: ClientRuntime,
): Promise<void> {
  let idleThreadIds = [...runtime.retainedThreads.keys()].filter(
    (threadId) => !runtime.protectedThreads.has(threadId),
  );
  while (idleThreadIds.length > CODEX_APP_SERVER_LIVE_THREAD_MAX_IDLE) {
    await releaseRetainedThread(client, runtime, idleThreadIds[0]!);
    idleThreadIds = [...runtime.retainedThreads.keys()].filter(
      (threadId) => !runtime.protectedThreads.has(threadId),
    );
  }
}

/** Retain separately owned Codex subscriptions; completing B must never cold-restart A. */
export async function retainCodexAppServerLiveThread(
  client: CodexAppServerClient,
  threadId: string,
  releaseThread?: (threadId: string) => Promise<void>,
  configFingerprint?: string,
  serviceTier?: CodexServiceTier | null,
): Promise<boolean> {
  const runtime = configuredClients.get(client);
  if (!runtime) {
    return false;
  }
  const pendingRelease = runtime.releasingThreads.get(threadId);
  if (pendingRelease) {
    await pendingRelease;
  }
  runtime.retainedThreads.delete(threadId);
  runtime.retainedThreads.set(threadId, {
    configFingerprint,
    serviceTier,
    expiresAt: Date.now() + CODEX_APP_SERVER_LIVE_THREAD_IDLE_TIMEOUT_MS,
    release:
      releaseThread ??
      (async (releasedThreadId) => {
        await client.request(
          "thread/unsubscribe",
          { threadId: releasedThreadId },
          { timeoutMs: 5_000 },
        );
      }),
  });

  // Map insertion order is the LRU. Active turns are claimed out of this map,
  // and detached native-child parents are pinned until their final child settles.
  await evictExcessIdleThreads(client, runtime);
  scheduleRetainedThreadEviction(client, runtime);
  return true;
}

/** Transfer one idle subscription to its next turn or compaction without touching sibling threads. */
export async function consumeCodexAppServerLiveThread(
  client: CodexAppServerClient,
  threadId: string,
  configFingerprint?: string,
): Promise<CodexAppServerLiveThreadOwnership | undefined> {
  const runtime = configuredClients.get(client);
  if (!runtime) {
    return undefined;
  }
  const pendingRelease = runtime.releasingThreads.get(threadId);
  if (pendingRelease) {
    await pendingRelease;
    return undefined;
  }
  const retained = runtime.retainedThreads.get(threadId);
  if (
    !retained ||
    (configFingerprint !== undefined && retained.configFingerprint !== configFingerprint)
  ) {
    return undefined;
  }
  runtime.retainedThreads.delete(threadId);
  scheduleRetainedThreadEviction(client, runtime);
  return {
    configFingerprint: retained.configFingerprint,
    serviceTier: retained.serviceTier,
    release: retained.release,
  };
}

/** Reset/end owns the exact thread; failed generation retirement must never release its successor. */
export async function releaseCodexAppServerLiveThread(
  client: CodexAppServerClient,
  threadId: string,
): Promise<boolean> {
  const runtime = configuredClients.get(client);
  return runtime ? await releaseRetainedThread(client, runtime, threadId) : false;
}

/** Native child work pins its parent's subscription even after the foreground parent turn ends. */
export function protectCodexAppServerLiveThread(
  client: CodexAppServerClient,
  threadId: string,
): () => void {
  const runtime = configuredClients.get(client);
  if (!runtime) {
    return () => undefined;
  }
  runtime.protectedThreads.set(threadId, (runtime.protectedThreads.get(threadId) ?? 0) + 1);
  scheduleRetainedThreadEviction(client, runtime);
  let protectedThread = true;
  return () => {
    if (!protectedThread) {
      return;
    }
    protectedThread = false;
    const count = runtime.protectedThreads.get(threadId) ?? 0;
    if (count <= 1) {
      runtime.protectedThreads.delete(threadId);
      const retained = runtime.retainedThreads.get(threadId);
      if (retained) {
        // A detached child is live activity, not parent idleness. Its terminal
        // delivery starts the parent's normal warm-session retention window.
        runtime.retainedThreads.delete(threadId);
        runtime.retainedThreads.set(threadId, {
          ...retained,
          expiresAt: Date.now() + CODEX_APP_SERVER_LIVE_THREAD_IDLE_TIMEOUT_MS,
        });
      }
    } else {
      runtime.protectedThreads.set(threadId, count - 1);
    }
    scheduleRetainedThreadEviction(client, runtime);
    void evictExcessIdleThreads(client, runtime).catch(() => client.close());
  };
}
