import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type {
  ClickClackDiscussionBinding,
  ClickClackDiscussionBindingStore,
} from "./binding-store.js";
import { markClickClackDiscussionChannelRevoked } from "./revoked-channel-store.js";

export class DetachedDiscussionBindingRetention {
  readonly #runtime: PluginRuntime;
  readonly #store: ClickClackDiscussionBindingStore;
  readonly #maxRetained: number;

  constructor(options: {
    runtime: PluginRuntime;
    store: ClickClackDiscussionBindingStore;
    maxRetained: number;
  }) {
    this.#runtime = options.runtime;
    this.#store = options.store;
    this.#maxRetained = options.maxRetained;
  }

  mark(sessionKey: string, binding: ClickClackDiscussionBinding): void {
    const current = this.#store.get(sessionKey);
    if (!current || !this.#sameRoom(current, binding)) {
      return;
    }
    if (current.detachedAt === undefined) {
      this.#store.set(sessionKey, { ...current, detachedAt: Date.now() });
    }
    while (this.#store.detachedCount() > this.#maxRetained) {
      if (!this.#pruneOldest()) {
        throw new Error("ClickClack detached discussion binding retention could not be reduced");
      }
    }
  }

  clear(
    sessionKey: string,
    binding: ClickClackDiscussionBinding,
  ): ClickClackDiscussionBinding | undefined {
    const current = this.#store.get(sessionKey);
    if (!current || !this.#sameRoom(current, binding)) {
      return undefined;
    }
    if (current.detachedAt === undefined) {
      return current;
    }
    const { detachedAt: _detachedAt, ...retained } = current;
    this.#store.set(sessionKey, retained);
    return retained;
  }

  ensureCapacity(sessionKey: string): void {
    while (!this.#store.hasCapacity(sessionKey)) {
      if (!this.#pruneOldest()) {
        throw new Error("ClickClack discussion binding capacity is exhausted");
      }
    }
  }

  #pruneOldest(): boolean {
    for (;;) {
      const oldest = this.#store.oldestDetached();
      if (!oldest) {
        return false;
      }
      const current = this.#store.get(oldest.sessionKey);
      if (!current || current.detachedAt === undefined) {
        continue;
      }
      const entry = this.#runtime.agent.session.getSessionEntry({
        sessionKey: oldest.sessionKey,
        readConsistency: "latest",
      });
      if (entry) {
        this.clear(oldest.sessionKey, current);
        continue;
      }
      markClickClackDiscussionChannelRevoked(this.#runtime, current);
      this.#store.delete(oldest.sessionKey);
      return true;
    }
  }

  #sameRoom(left: ClickClackDiscussionBinding, right: ClickClackDiscussionBinding): boolean {
    return (
      left.serverBaseUrl === right.serverBaseUrl &&
      left.channelId === right.channelId &&
      left.externalRef === right.externalRef
    );
  }
}
