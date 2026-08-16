import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { discussionSessionKey } from "./naming.js";

export type ClickClackDiscussionBinding = {
  accountId: string;
  agentId: string;
  /** Concrete session incarnation; session keys can be reused after reset. */
  sessionId: string;
  serverBaseUrl: string;
  /** Non-secret digest used only to determine whether old-channel credentials remain available. */
  credentialFingerprint?: string;
  externalRef: string;
  externalUrl: string;
  /** Configured workspace selector at bind time; workspaceId is its canonical resolution. */
  workspaceRef: string;
  workspaceId: string;
  channelId: string;
  channelRouteId: string;
  workspaceRouteId: string;
  section: string;
  archived: boolean;
  label: string;
  displayTitle?: string;
  /** Set only while the owning OpenClaw session entry is absent. */
  detachedAt?: number;
};

export function bindingMatchesActiveSessionIncarnation(
  runtime: PluginRuntime,
  sessionKey: string,
  binding: ClickClackDiscussionBinding,
): boolean {
  const entry = runtime.agent.session.getSessionEntry({
    sessionKey,
    readConsistency: "latest",
  });
  return Boolean(
    entry &&
    binding.sessionId &&
    entry.sessionId === binding.sessionId &&
    entry.archivedAt === undefined,
  );
}

/**
 * Refresh the replaceable session attachment without changing the durable room identity.
 * The store registers persisted state before reindexing, so a failed write leaves the
 * previous attachment authoritative in both persistence and memory.
 */
export function attachBindingToCurrentActiveSession(params: {
  runtime: PluginRuntime;
  store: ClickClackDiscussionBindingStore;
  sessionKey: string;
  binding: ClickClackDiscussionBinding;
}): ClickClackDiscussionBinding | undefined {
  const entry = params.runtime.agent.session.getSessionEntry({
    sessionKey: params.sessionKey,
    readConsistency: "latest",
  });
  if (!entry?.sessionId || entry.archivedAt !== undefined) {
    return undefined;
  }
  if (entry.sessionId === params.binding.sessionId) {
    if (params.binding.detachedAt === undefined) {
      return params.binding;
    }
    const { detachedAt: _detachedAt, ...attached } = params.binding;
    params.store.set(params.sessionKey, attached);
    return attached;
  }
  const { detachedAt: _detachedAt, ...retained } = params.binding;
  const attached = { ...retained, sessionId: entry.sessionId };
  params.store.set(params.sessionKey, attached);
  return attached;
}

const DISCUSSION_BINDINGS_NAMESPACE = "discussion-bindings";
const MAX_DISCUSSION_BINDINGS = 10_000;
export const MAX_RETAINED_DETACHED_DISCUSSION_BINDINGS = 1_000;
const storesByRuntime = new WeakMap<PluginRuntime, ClickClackDiscussionBindingStore>();

function channelKey(serverBaseUrl: string, channelId: string): string {
  return `${serverBaseUrl.replace(/\/+$/u, "")}\0${channelId}`;
}

/** SQLite-backed session/channel bindings with a process-local inbound lookup index. */
export class ClickClackDiscussionBindingStore {
  readonly #store: PluginStateSyncKeyedStore<ClickClackDiscussionBinding>;
  readonly #sessionByChannel = new Map<string, string>();
  readonly #mainByDiscussionSession = new Map<string, string>();
  readonly #detachedAtBySession = new Map<string, number>();
  readonly #runtime: PluginRuntime;

  constructor(runtime: PluginRuntime) {
    this.#runtime = runtime;
    this.#store = runtime.state.openSyncKeyedStore<ClickClackDiscussionBinding>({
      namespace: DISCUSSION_BINDINGS_NAMESPACE,
      maxEntries: MAX_DISCUSSION_BINDINGS,
      overflowPolicy: "reject-new",
    });
    for (const entry of this.#store.entries()) {
      this.#index(entry.key, entry.value);
    }
  }

  get(sessionKey: string): ClickClackDiscussionBinding | undefined {
    return this.#store.lookup(sessionKey);
  }

  hasCapacity(sessionKey: string): boolean {
    return (
      this.get(sessionKey) !== undefined || this.#store.entries().length < MAX_DISCUSSION_BINDINGS
    );
  }

  getByChannel(
    serverBaseUrl: string,
    channelId: string,
  ): { sessionKey: string; binding: ClickClackDiscussionBinding } | undefined {
    const key = channelKey(serverBaseUrl, channelId);
    const sessionKey = this.#sessionByChannel.get(key);
    if (!sessionKey) {
      return undefined;
    }
    const binding = this.get(sessionKey);
    if (!binding) {
      this.#sessionByChannel.delete(key);
      return undefined;
    }
    return { sessionKey, binding };
  }

  set(sessionKey: string, binding: ClickClackDiscussionBinding): void {
    const previous = this.get(sessionKey);
    this.#store.register(sessionKey, binding);
    if (previous) {
      this.#unindex(sessionKey, previous);
    }
    this.#index(sessionKey, binding);
  }

  delete(sessionKey: string): boolean {
    const previous = this.get(sessionKey);
    const deleted = this.#store.delete(sessionKey);
    if (deleted && previous) {
      this.#unindex(sessionKey, previous);
    }
    return deleted;
  }

  getByDiscussionSession(
    sideSessionKey: string,
  ): { sessionKey: string; binding: ClickClackDiscussionBinding } | undefined {
    const sessionKey = this.#mainByDiscussionSession.get(sideSessionKey);
    if (!sessionKey) {
      return undefined;
    }
    const binding = this.get(sessionKey);
    return binding ? { sessionKey, binding } : undefined;
  }

  entries(): Array<{ sessionKey: string; binding: ClickClackDiscussionBinding }> {
    return this.#store.entries().map((entry) => ({ sessionKey: entry.key, binding: entry.value }));
  }

  detachedCount(): number {
    return this.#detachedAtBySession.size;
  }

  oldestDetached(): { sessionKey: string; binding: ClickClackDiscussionBinding } | undefined {
    let oldestSessionKey: string | undefined;
    let oldestDetachedAt = Number.POSITIVE_INFINITY;
    for (const [sessionKey, detachedAt] of this.#detachedAtBySession) {
      if (
        detachedAt < oldestDetachedAt ||
        (detachedAt === oldestDetachedAt &&
          (oldestSessionKey === undefined || sessionKey < oldestSessionKey))
      ) {
        oldestSessionKey = sessionKey;
        oldestDetachedAt = detachedAt;
      }
    }
    if (!oldestSessionKey) {
      return undefined;
    }
    const binding = this.get(oldestSessionKey);
    if (!binding || binding.detachedAt === undefined) {
      this.#detachedAtBySession.delete(oldestSessionKey);
      return this.oldestDetached();
    }
    return { sessionKey: oldestSessionKey, binding };
  }

  #index(sessionKey: string, binding: ClickClackDiscussionBinding): void {
    this.#sessionByChannel.set(channelKey(binding.serverBaseUrl, binding.channelId), sessionKey);
    const sideSessionKey = discussionSessionKey({
      runtime: this.#runtime,
      agentId: binding.agentId,
      mainSessionKey: sessionKey,
      sessionId: binding.sessionId,
      accountId: binding.accountId,
      serverBaseUrl: binding.serverBaseUrl,
      channelId: binding.channelId,
      externalRef: binding.externalRef,
    });
    if (sideSessionKey) {
      this.#mainByDiscussionSession.set(sideSessionKey, sessionKey);
    }
    if (binding.detachedAt !== undefined) {
      this.#detachedAtBySession.set(sessionKey, binding.detachedAt);
    }
  }

  #unindex(sessionKey: string, binding: ClickClackDiscussionBinding): void {
    this.#sessionByChannel.delete(channelKey(binding.serverBaseUrl, binding.channelId));
    const sideSessionKey = discussionSessionKey({
      runtime: this.#runtime,
      agentId: binding.agentId,
      mainSessionKey: sessionKey,
      sessionId: binding.sessionId,
      accountId: binding.accountId,
      serverBaseUrl: binding.serverBaseUrl,
      channelId: binding.channelId,
      externalRef: binding.externalRef,
    });
    if (sideSessionKey) {
      this.#mainByDiscussionSession.delete(sideSessionKey);
    }
    this.#detachedAtBySession.delete(sessionKey);
  }
}

export function getClickClackDiscussionBindingStore(
  runtime: PluginRuntime,
): ClickClackDiscussionBindingStore {
  const existing = storesByRuntime.get(runtime);
  if (existing) {
    return existing;
  }
  const created = new ClickClackDiscussionBindingStore(runtime);
  storesByRuntime.set(runtime, created);
  return created;
}
