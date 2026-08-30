import { compareChatQueueOrder } from "../../lib/chat/chat-queue-order.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { subscribeStoredChatOutboxChanges } from "../../lib/chat/outbox-store.ts";
import { getSafeSessionStorage } from "../../local-storage.ts";
import { getChatAttachmentDataUrl } from "./attachment-payload-store.ts";
import {
  listStoredChatOutboxes,
  updateStoredChatComposerQueueItem,
  resolveStoredChatOutboxScope,
  storedChatOutboxScopeKey,
  type ChatComposerScope as Composer,
  type StoredChatOutboxScope as Scope,
} from "./composer-persistence.ts";
import {
  captureOutboxPayloadOwner,
  failOutboxPayload,
  observeOutboxRecoveryOwner,
  prepareOutboxPayload,
} from "./outbox-payloads.ts";
type Host = Composer & { chatQueue: ChatQueueItem[]; sessionKey: string; requestUpdate?(): void };
type HostProjection = {
  byScope: Map<string, ChatQueueItem[]>;
  durableSeen: Set<string>;
  retryable: Set<string>;
};
type LiveProjection = { item: ChatQueueItem; owner: Host };
const LIVE_VERSION_KEYS = ["sendRunId", "sendAttempts", "sendState", "sendError"] as const;
const routePresentation = new WeakSet<ChatQueueItem>();
const storageIds = new WeakMap<Storage, number>();
let nextStorageId = 0;
function isActiveLocal(state: HostProjection, item: ChatQueueItem): boolean {
  return Boolean(
    item.pendingRunId ||
    item.sendState === "waiting-model" ||
    state.retryable.has(item.id) ||
    !state.durableSeen.has(item.id),
  );
}
// One gateway owner merges durable, live, and pane-local rows for every subscribed pane.
class ChatOutboxGatewayOwner {
  private readonly hosts = new Map<Host, HostProjection>();
  private readonly panes = new Set<Host>();
  private readonly live = new Map<string, Map<string, LiveProjection>>();
  private readonly hydrating = new Set<string>();
  private unsubscribe: (() => void) | null = null;
  constructor(readonly ownerGatewayKey: string) {}
  private state(host: Host): HostProjection {
    const existing = this.hosts.get(host);
    if (existing) {
      return existing;
    }
    const scope = resolveStoredChatOutboxScope(host, host.sessionKey);
    const durableSeen = new Set(this.outbox(host, scope)?.queue.map((item) => item.id));
    const created: HostProjection = { byScope: new Map(), durableSeen, retryable: new Set() };
    if (host.chatQueue.length) {
      created.byScope.set(
        storedChatOutboxScopeKey(scope),
        host.chatQueue.filter(
          (item) =>
            !item.attachmentPayload ||
            item.attachmentPayload.recoveryScope === host.client?.recoveryScope,
        ),
      );
    }
    this.hosts.set(host, created);
    return created;
  }
  private outbox(host: Composer, scope: Scope) {
    return listStoredChatOutboxes(host).find(
      ({ sessionKey, agentId }) => sessionKey === scope.sessionKey && agentId === scope.agentId,
    );
  }
  durable(host: Composer, id: string) {
    return listStoredChatOutboxes(host).find(({ queue }) => queue.some((item) => item.id === id));
  }
  private project(item: ChatQueueItem, local: ChatQueueItem, sessionKey: string): ChatQueueItem {
    const projected: ChatQueueItem = { ...item };
    if (local.attachments) {
      const presented = new Map(local.attachments.map((attachment) => [attachment.id, attachment]));
      projected.attachments = (item.attachments ?? local.attachments).map((attachment) =>
        Object.assign({}, attachment, presented.get(attachment.id)),
      );
    }
    for (const key of ["sendSubmittedAtMs", "sendRequestStartedAtMs"] as const) {
      if (typeof local[key] === "number") {
        projected[key] = local[key];
      }
    }
    if (routePresentation.has(local) && (!local.sessionKey || local.sessionKey === sessionKey)) {
      routePresentation.add(projected);
      for (const key of ["sessionKey", "agentId"] as const) {
        if (Object.hasOwn(local, key)) {
          projected[key] = local[key];
        } else {
          delete projected[key];
        }
      }
    }
    return projected;
  }
  snapshot(host: Host, scope: Scope): ChatQueueItem[] {
    const key = storedChatOutboxScopeKey(scope);
    const durable = this.outbox(host, scope)?.queue ?? [];
    const state = this.state(host);
    const local = state.byScope.get(key) ?? [];
    const localById = new Map(local.map((item) => [item.id, item]));
    const visible = durable.map((item) => {
      state.durableSeen.add(item.id);
      const pending = localById.get(item.id);
      const live = this.live.get(key)?.get(item.id)?.item;
      return pending?.pendingRunId || pending?.sendState === "waiting-model"
        ? pending
        : live && live.sendRunId === item.sendRunId
          ? live
          : pending && pending.sendRunId === item.sendRunId
            ? this.project(item, pending, host.sessionKey)
            : item;
    });
    const durableIds = new Set(durable.map((item) => item.id));
    visible.push(...local.filter((item) => !durableIds.has(item.id) && isActiveLocal(state, item)));
    this.prune(host);
    return visible.toSorted(compareChatQueueOrder);
  }
  syncHost(host: Host, options: { requestUpdate?: boolean } = {}): void {
    if (this.ownerGatewayKey !== outboxOwnerKey(host)) {
      chatOutboxOwner(host).syncHost(host, options);
      return;
    }
    observeOutboxRecoveryOwner(host);
    host.chatQueue = this.snapshot(host, resolveStoredChatOutboxScope(host, host.sessionKey));
    for (const item of host.chatQueue) {
      const key = item.attachmentPayload?.key;
      if (
        !key ||
        item.attachmentStorageError ||
        this.hydrating.has(key) ||
        item.attachments?.every((attachment) => getChatAttachmentDataUrl(attachment))
      ) {
        continue;
      }
      this.hydrating.add(key);
      const isCurrent = captureOutboxPayloadOwner(host);
      void prepareOutboxPayload(host, item)
        .then((result) => {
          if (!isCurrent()) {
            return;
          }
          const outbox = this.durable(host, item.id);
          const current = outbox?.queue.find((row) => row.id === item.id);
          if (!outbox || current?.attachmentPayload?.key !== key) {
            return;
          }
          if (result.status === "ready") {
            if (result.item.attachmentPayload?.key !== key) {
              // Copy adoption must not overwrite a retry that replaced the captured row.
              if (
                !updateStoredChatComposerQueueItem(
                  host,
                  outbox.sessionKey,
                  item,
                  result.item,
                  outbox.agentId,
                )
              ) {
                return;
              }
            }
            this.keep(host, outbox, {
              ...current,
              attachments: result.item.attachments,
              ...(result.item.attachmentPayload?.key !== key
                ? {
                    attachmentPayload: result.item.attachmentPayload,
                    sendState: result.item.sendState,
                    sendError: result.item.sendError,
                  }
                : {}),
            });
          } else {
            updateStoredChatComposerQueueItem(
              host,
              outbox.sessionKey,
              current,
              failOutboxPayload(current, result.reason),
              outbox.agentId,
            );
          }
          this.publish(host);
        })
        .finally(() => this.hydrating.delete(key));
    }
    if (options.requestUpdate !== false) {
      host.requestUpdate?.();
    }
  }
  publish(origin?: Host, reconcile = false): void {
    if (origin) {
      this.syncHost(origin);
    }
    for (const pane of this.panes) {
      if (pane !== origin) {
        if (reconcile) {
          this.reconcile(pane, this.state(pane));
        }
        this.syncHost(pane);
      }
    }
  }
  adoptSubscriptions(host: Composer): void {
    const previous = subscriptions.get(host)?.owner;
    if (!previous || previous === this) {
      return;
    }
    // A shared client's credentials change before pane callbacks run. Move peers
    // together so the first reconnect drain still observes every pane's edit hold.
    for (const pane of previous.panes) {
      if (outboxOwnerKey(pane) !== this.ownerGatewayKey) {
        continue;
      }
      subscriptions.get(pane)!.owner = this;
      previous.hosts.delete(pane);
      for (const [key, live] of previous.live) {
        for (const [id, projection] of live) {
          if (projection.owner === pane) {
            live.delete(id);
          }
        }
        if (!live.size) {
          previous.live.delete(key);
        }
      }
      // Stored rows remain authoritative; old credential-local overlays do not.
      pane.chatQueue = [];
      previous.detach(pane);
      this.attach(pane);
    }
  }
  private attach(host: Host): void {
    this.panes.add(host);
    this.unsubscribe ??= subscribeStoredChatOutboxChanges(() => this.publish(undefined, true));
  }
  private detach(host: Host): void {
    this.panes.delete(host);
    if (!this.panes.size) {
      this.unsubscribe?.();
      this.unsubscribe = null;
    }
    this.prune(host);
  }
  subscribe(host: Host): () => void {
    const subscription = { owner: this };
    subscriptions.set(host, subscription);
    this.attach(host);
    this.reconcile(host, this.state(host));
    this.syncHost(host, { requestUpdate: false });
    return () => {
      if (subscriptions.get(host) !== subscription) {
        return;
      }
      subscriptions.delete(host);
      subscription.owner.detach(host);
    };
  }
  private reconcile(host: Host, state: HostProjection): void {
    const durableIds = new Set(
      listStoredChatOutboxes(host).flatMap((outbox) => outbox.queue.map((item) => item.id)),
    );
    durableIds.forEach((id) => state.durableSeen.add(id));
    for (const [key, queue] of state.byScope) {
      state.byScope.set(
        key,
        queue.filter((item) => durableIds.has(item.id) || isActiveLocal(state, item)),
      );
    }
  }
  replace(
    host: Host,
    scope: Scope,
    queue: ChatQueueItem[],
    options: { requestUpdate?: boolean } = {},
  ): void {
    const state = this.state(host);
    const key = storedChatOutboxScopeKey(scope);
    const previous = state.byScope.get(key) ?? [];
    const previousById = new Map(previous.map((item) => [item.id, item]));
    const retainedIds = new Set(queue.map((item) => item.id));
    for (const item of previous) {
      if (!retainedIds.has(item.id)) {
        state.retryable.delete(item.id);
      }
    }
    this.outbox(host, scope)?.queue.forEach((item) => state.durableSeen.add(item.id));
    state.byScope.set(
      key,
      queue.map((item) => this.project(item, previousById.get(item.id) ?? item, host.sessionKey)),
    );
    this.syncHost(host, options);
  }
  keep(host: Host, scope: Scope, item: ChatQueueItem, retryable = false): void {
    const state = this.state(host);
    const key = storedChatOutboxScopeKey(scope);
    const queue = (state.byScope.get(key) ?? []).filter((entry) => entry.id !== item.id);
    queue.push(item);
    queue.sort(compareChatQueueOrder);
    state.byScope.set(key, queue);
    routePresentation.add(item);
    if (retryable) {
      state.retryable.add(item.id);
    }
    this.syncHost(host);
  }
  private local(state: HostProjection, id: string) {
    for (const [key, queue] of state.byScope) {
      const index = queue.findIndex((item) => item.id === id);
      if (index >= 0) {
        return { key, queue, index };
      }
    }
    return undefined;
  }
  change(
    host: Host,
    id: string,
    update?: (item: ChatQueueItem) => ChatQueueItem,
    retryable = false,
  ): ChatQueueItem | null {
    const state = this.state(host);
    const match = this.local(state, id);
    if (!match) {
      this.prune(host);
      return null;
    }
    const current = match.queue[match.index]!;
    if (update) {
      const next = update(current);
      match.queue[match.index] = next;
      routePresentation.add(next);
      if (retryable) {
        state.retryable.add(id);
      }
      this.syncHost(host);
      return next;
    }
    state.retryable.delete(id);
    const stored = this.durable(host, id)?.queue.find((item) => item.id === id);
    if (stored) {
      state.durableSeen.add(id);
      match.queue[match.index] = this.project(stored, current, host.sessionKey);
    } else {
      match.queue.splice(match.index, 1);
      state.byScope.set(match.key, match.queue);
    }
    this.syncHost(host);
    return current;
  }
  hasVolatile(host: Host, id: string): boolean {
    return this.hosts.get(host)?.retryable.has(id) ?? false;
  }
  // Panes share this outbox and its drain while composer state stays per pane, so
  // a pane-local fact that blocks delivery has to be answerable from any of them.
  anyPane(matches: (host: Host) => boolean): boolean {
    for (const pane of this.panes) {
      if (matches(pane)) {
        return true;
      }
    }
    return false;
  }
  mayRemove(host: Host, scope: Scope, id: string): boolean {
    const live = this.live.get(storedChatOutboxScopeKey(scope))?.get(id);
    const local = host.chatQueue.find((item) => item.id === id);
    const durable = this.outbox(host, scope)?.queue.find((item) => item.id === id);
    return Boolean(
      !live ||
      live.owner === host ||
      (local && durable && LIVE_VERSION_KEYS.every((key) => local[key] === durable[key])),
    );
  }
  projectLive(host: Host, scope: Scope, id: string, item?: ChatQueueItem): void {
    const key = storedChatOutboxScopeKey(scope);
    const live = this.live.get(key) ?? new Map<string, LiveProjection>();
    if (item) {
      live.set(id, { item, owner: host });
      this.live.set(key, live);
    } else {
      live.delete(id);
      if (!live.size) {
        this.live.delete(key);
      }
    }
    this.publish(host);
    this.prune(host);
  }
  allItems(host: Host): ChatQueueItem[] {
    const durable = listStoredChatOutboxes(host).flatMap((outbox) => this.snapshot(host, outbox));
    const local = [...this.state(host).byScope.values()].flat();
    const items = new Map([...durable, ...local].map((item) => [item.id, item]));
    this.prune(host);
    return [...items.values()];
  }
  private prune(host: Host): void {
    const state = this.hosts.get(host);
    if (state && !this.panes.has(host)) {
      const active = [...state.byScope.values()].some((queue) =>
        queue.some((item) => isActiveLocal(state, item)),
      );
      if (!active && !this.live.size) {
        this.hosts.delete(host);
      }
    }
    if (!this.unsubscribe && !this.live.size && !this.hosts.size) {
      // Defer eviction until a synchronous send transition can add its live overlay.
      queueMicrotask(() => {
        if (
          !this.unsubscribe &&
          !this.live.size &&
          !this.hosts.size &&
          owners.get(this.ownerGatewayKey) === this
        ) {
          owners.delete(this.ownerGatewayKey);
        }
      });
    }
  }
}
const owners = new Map<string, ChatOutboxGatewayOwner>();
const subscriptions = new WeakMap<Composer, { owner: ChatOutboxGatewayOwner }>();
function outboxOwnerKey(host: Composer): string {
  const storage = getSafeSessionStorage();
  if (storage && !storageIds.has(storage)) {
    storageIds.set(storage, ++nextStorageId);
  }
  const key = `${storage ? storageIds.get(storage) : 0}\u0000${host.settings?.gatewayUrl?.trim() || "default"}\u0000${host.client?.recoveryScope ?? ""}`;
  return key;
}
export function chatOutboxOwner(host: Composer): ChatOutboxGatewayOwner {
  const key = outboxOwnerKey(host);
  const owner = owners.get(key) ?? new ChatOutboxGatewayOwner(key);
  owners.set(key, owner);
  owner.adoptSubscriptions(host);
  return owner;
}
