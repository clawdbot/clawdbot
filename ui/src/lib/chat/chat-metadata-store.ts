import {
  DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
  resolveGatewayStartupRetryAfterMs,
} from "@openclaw/gateway-client/browser";
import type {
  ChatMetadataParams,
  CommandsListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
export type ChatMetadataResult = CommandsListResult;

type ChatMetadataUpdate =
  | { type: "invalidated" }
  | { type: "loading" }
  | { type: "result"; result: ChatMetadataResult }
  | { type: "error"; error: unknown };
type ChatMetadataEntry = {
  scope: ChatMetadataParams;
  result?: ChatMetadataResult;
  loadPending?: Promise<ChatMetadataResult>;
  revalidationPending?: Promise<ChatMetadataResult>;
  writer?: object;
  listeners: Set<(update: ChatMetadataUpdate) => void>;
  release: () => void;
};

const chatMetadataCache = new WeakMap<GatewayBrowserClient, Map<string, ChatMetadataEntry>>();

function metadataScopeKey(scope: ChatMetadataParams): string {
  return JSON.stringify([scope.agentId?.trim() ?? "", scope.sessionKey ?? null]);
}

function metadataEntryFor(
  client: GatewayBrowserClient,
  params: ChatMetadataParams,
): ChatMetadataEntry {
  const key = metadataScopeKey(params);
  let cache = chatMetadataCache.get(client);
  if (!cache) {
    cache = new Map();
    chatMetadataCache.set(client, cache);
  }
  let entry = cache.get(key);
  if (!entry) {
    const created: ChatMetadataEntry = {
      scope: params,
      listeners: new Set(),
      release: () => {
        // Session projections live with their consumers, not every conversation ever opened.
        // Retire the writer too: a late startup/read cannot repopulate a released entry.
        if (params.sessionKey && created.listeners.size === 0) {
          created.writer = undefined;
          if (cache.get(key) === created) {
            cache.delete(key);
          }
        }
      },
    };
    entry = created;
    cache.set(key, entry);
  }
  return entry;
}

function waitForMetadataRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, delayMs);
  });
}

function notifyChatMetadataListeners(entry: ChatMetadataEntry, update: ChatMetadataUpdate): void {
  for (const listener of Array.from(entry.listeners)) {
    try {
      listener(update);
    } catch (error) {
      console.error("[chat-metadata] listener error:", error);
    }
  }
}

async function requestChatMetadata(
  client: GatewayBrowserClient,
  params: ChatMetadataParams,
  opts?: { startupRetryWindowMs?: number },
): Promise<ChatMetadataResult> {
  const retryWindowMs = opts?.startupRetryWindowMs;
  if (retryWindowMs === undefined) {
    return client.request<ChatMetadataResult>("chat.metadata", params);
  }

  const deadlineAt = Date.now() + retryWindowMs;
  let latestStartupError: Error | undefined;

  while (true) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw latestStartupError ?? new Error("New-session metadata retry deadline elapsed");
    }

    try {
      return await client.request<ChatMetadataResult>("chat.metadata", params, {
        timeoutMs: Math.min(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS, remainingMs),
      });
    } catch (error) {
      const requestError =
        error instanceof Error
          ? error
          : new Error("New-session metadata request failed", { cause: error });
      const retryAfterMs = resolveGatewayStartupRetryAfterMs(requestError);
      if (retryAfterMs === null) {
        throw requestError;
      }

      const retryRemainingMs = deadlineAt - Date.now();
      if (retryRemainingMs <= 0) {
        throw requestError;
      }

      latestStartupError = requestError;
      await waitForMetadataRetry(Math.min(retryAfterMs, retryRemainingMs));
    }
  }
}

function beginPublication(entry: ChatMetadataEntry) {
  const writer = {};
  entry.writer = writer;
  entry.loadPending = undefined;
  entry.revalidationPending = undefined;
  const isCurrent = () => entry.writer === writer;
  notifyChatMetadataListeners(entry, { type: "loading" });
  return {
    isCurrent,
    publish: (result: ChatMetadataResult) => {
      if (isCurrent()) {
        entry.result = result;
        notifyChatMetadataListeners(entry, { type: "result", result });
      }
      entry.release();
    },
    fail: (error: unknown) => {
      if (isCurrent()) {
        notifyChatMetadataListeners(entry, { type: "error", error });
      }
      entry.release();
    },
  };
}

function beginChatMetadataRequest(
  entry: ChatMetadataEntry,
  pendingKey: "loadPending" | "revalidationPending",
  request: Promise<ChatMetadataResult>,
): Promise<ChatMetadataResult> {
  const publication = beginPublication(entry);
  const pending = request
    .then(
      (result) => {
        publication.publish(result);
        return result;
      },
      (error: unknown) => {
        publication.fail(error);
        throw error;
      },
    )
    .finally(() => {
      if (entry[pendingKey] === pending) {
        entry[pendingKey] = undefined;
      }
    });
  entry[pendingKey] = pending;
  return pending;
}

export function peekChatMetadata(
  client: GatewayBrowserClient,
  scope: ChatMetadataParams,
): ChatMetadataResult | undefined {
  return chatMetadataCache.get(client)?.get(metadataScopeKey(scope))?.result;
}

export function subscribeChatMetadata(
  client: GatewayBrowserClient,
  scope: ChatMetadataParams,
  listener: (update: ChatMetadataUpdate) => void,
): () => void {
  const entry = metadataEntryFor(client, scope);
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
    entry.release();
  };
}

export function loadChatMetadata(
  client: GatewayBrowserClient,
  scope: ChatMetadataParams,
): Promise<ChatMetadataResult> {
  const entry = metadataEntryFor(client, scope);
  if (entry.result) {
    return Promise.resolve(entry.result);
  }
  const pending = entry.loadPending ?? entry.revalidationPending;
  if (pending) {
    return pending;
  }
  return beginChatMetadataRequest(entry, "loadPending", requestChatMetadata(client, entry.scope));
}

export function revalidateChatMetadata(
  client: GatewayBrowserClient,
  scope: ChatMetadataParams,
  opts?: { startupRetryWindowMs?: number },
): Promise<ChatMetadataResult> {
  const entry = metadataEntryFor(client, scope);
  if (entry.revalidationPending) {
    return entry.revalidationPending;
  }
  return beginChatMetadataRequest(
    entry,
    "revalidationPending",
    requestChatMetadata(client, entry.scope, opts),
  );
}

export function beginChatMetadataPublication(
  client: GatewayBrowserClient,
  scope: ChatMetadataParams,
) {
  const { isCurrent, publish } = beginPublication(metadataEntryFor(client, scope));
  return { isCurrent, publish };
}

export function invalidateChatMetadataStore(
  client: GatewayBrowserClient,
  scope?: ChatMetadataParams,
): void {
  const entries = chatMetadataCache.get(client)?.values();
  if (!entries) {
    return;
  }
  const invalidated = Array.from(entries).filter(
    (entry) =>
      (!scope?.agentId || entry.scope.agentId === scope.agentId) &&
      (!scope?.sessionKey || entry.scope.sessionKey === scope.sessionKey),
  );
  // Retire every affected writer before subscribers can synchronously start replacements.
  for (const entry of invalidated) {
    entry.result = undefined;
    entry.loadPending = undefined;
    entry.revalidationPending = undefined;
    entry.writer = undefined;
  }
  for (const entry of invalidated) {
    notifyChatMetadataListeners(entry, { type: "invalidated" });
    entry.release();
  }
}
