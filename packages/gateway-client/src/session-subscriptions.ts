import {
  GatewayProtocolRequestTimeoutError,
  type GatewayProtocolRequestOptions,
} from "./protocol-request.js";
import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "./timeouts.js";

export type GatewaySessionMessageRequestClient = {
  request<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    options?: GatewayProtocolRequestOptions,
  ): Promise<T>;
};

export type GatewaySessionMessageSubscription = {
  key: string;
  agentId?: string | null;
  includeApprovals?: true;
  approvalReplay?: unknown;
};

export type GatewaySessionMessageSubscriptionOptions = {
  agentId?: string | null;
  includeApprovals?: boolean;
};

type SessionMessageSubscriptionResponse = {
  key: string;
  approvalReplay?: unknown;
};

type SessionMessageSubscriptionEntry = {
  key: string;
  requestedKeys: Set<string>;
  agentId: string | null;
  ready: Promise<SessionMessageSubscriptionResponse>;
  approvalRequest: Promise<SessionMessageSubscriptionResponse> | null;
  plainFallback: Promise<SessionMessageSubscriptionResponse> | null;
  canonicalSettled: boolean;
  handles: Set<GatewaySessionMessageSubscription>;
  pendingOwners: number;
  release: Promise<void> | null;
};

type SessionMessageSubscriptionOwner = {
  coordinator: GatewaySessionMessageSubscriptionCoordinator;
  entry: SessionMessageSubscriptionEntry;
};

export type GatewaySessionMessageSubscriptionCoordinatorOptions = {
  keysEquivalent?: (left: string, right: string) => boolean;
};

function sessionSubscriptionParams(key: string, agentId: string | null) {
  return {
    key: key.trim(),
    ...(agentId ? { agentId } : {}),
  };
}

/**
 * One Gateway connection owns one targeted observer per canonical session.
 * Approval delivery is an upgrade of that observer, never a second observer.
 */
export class GatewaySessionMessageSubscriptionCoordinator {
  readonly #client: GatewaySessionMessageRequestClient;
  // Choose one matcher before the first lease; changing live aliases splits wire ownership.
  #keysEquivalent?: (left: string, right: string) => boolean;
  readonly #entries = new Set<SessionMessageSubscriptionEntry>();
  #retired = false;

  constructor(
    client: GatewaySessionMessageRequestClient,
    options: GatewaySessionMessageSubscriptionCoordinatorOptions = {},
  ) {
    this.#client = client;
    this.#keysEquivalent = options.keysEquivalent;
  }

  configure(options: GatewaySessionMessageSubscriptionCoordinatorOptions = {}): this {
    const matcher = options.keysEquivalent;
    if (!matcher || matcher === this.#keysEquivalent) {
      return this;
    }
    if (this.#keysEquivalent || this.#entries.size > 0) {
      throw new Error("Session message key equivalence cannot change for an active connection");
    }
    this.#keysEquivalent = matcher;
    return this;
  }

  async acquire(
    key: string,
    options: GatewaySessionMessageSubscriptionOptions = {},
  ): Promise<GatewaySessionMessageSubscription> {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      throw new Error("Session message subscription requires a session key");
    }
    const agentId = options.agentId?.trim() || null;

    let entry: SessionMessageSubscriptionEntry;
    while (true) {
      if (this.#retired) {
        throw new Error("Session message subscription belongs to a replaced Gateway connection");
      }
      const existing = [...this.#entries].find(
        (candidate) =>
          candidate.agentId === agentId &&
          (this.#areKeysEquivalent(candidate.key, normalizedKey) ||
            [...candidate.requestedKeys].some((requestedKey) =>
              this.#areKeysEquivalent(requestedKey, normalizedKey),
            )),
      );
      if (!existing) {
        const provisional = [...this.#entries].find(
          (candidate) =>
            candidate.agentId === agentId &&
            !candidate.canonicalSettled &&
            this.#couldShareCanonicalIdentity(candidate.key, normalizedKey),
        );
        if (provisional) {
          // Only potentially aliased sessions need the first Gateway acknowledgment;
          // unrelated bodies must not inherit another observer's request deadline.
          await (provisional.plainFallback ?? provisional.ready).catch(() => undefined);
          continue;
        }
        entry = this.#createEntry(normalizedKey, agentId, options.includeApprovals === true);
        break;
      }
      if (!existing.release) {
        entry = existing;
        entry.requestedKeys.add(normalizedKey);
        break;
      }
      // A final release must settle before a new owner decides whether the
      // same wire observer can be reused or must be subscribed again.
      await existing.release.catch(() => undefined);
    }

    entry.pendingOwners += 1;
    try {
      const result = await this.#acquireCapability(entry, options.includeApprovals === true);
      if (this.#retired) {
        throw new Error("Session message subscription completed on a replaced Gateway connection");
      }

      const subscription: GatewaySessionMessageSubscription = {
        key: result.key,
        agentId,
        ...(options.includeApprovals === true
          ? {
              includeApprovals: true as const,
              ...(result.approvalReplay !== undefined
                ? { approvalReplay: result.approvalReplay }
                : {}),
            }
          : {}),
      };
      entry.handles.add(subscription);
      sessionMessageSubscriptionOwners.set(subscription, {
        coordinator: this,
        entry,
      });
      return subscription;
    } finally {
      entry.pendingOwners -= 1;
      if (entry.pendingOwners === 0 && entry.handles.size === 0 && !entry.release) {
        this.#entries.delete(entry);
      }
    }
  }

  release(subscription: GatewaySessionMessageSubscription): Promise<void> {
    const owner = sessionMessageSubscriptionOwners.get(subscription);
    if (!owner || owner.coordinator !== this) {
      return Promise.resolve();
    }
    const { entry } = owner;
    if (this.#retired || entry.handles.size > 1) {
      this.#finishRelease(subscription, owner);
      return Promise.resolve();
    }
    if (entry.release) {
      return entry.release;
    }
    if (entry.pendingOwners > 0) {
      // Keep the final live handle until every provisional owner commits or
      // fails; otherwise a rejected approval upgrade or acquire orphans it.
      const pending = [entry.ready, ...(entry.approvalRequest ? [entry.approvalRequest] : [])];
      const tracked = Promise.allSettled(pending).then(() => {
        if (entry.release === tracked) {
          entry.release = null;
        }
        return this.release(subscription);
      });
      entry.release = tracked;
      return tracked;
    }

    // Retain both the handle and its wire entry until the Gateway acknowledges
    // the last release. A rejected unsubscribe must remain genuinely retryable.
    const request = this.#client
      .request(
        "sessions.messages.unsubscribe",
        sessionSubscriptionParams(entry.key, entry.agentId),
        { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
      )
      .then(() => {
        this.#finishRelease(subscription, owner, true);
      });
    const tracked = request.finally(() => {
      if (entry.release === tracked) {
        entry.release = null;
      }
    });
    entry.release = tracked;
    return tracked;
  }

  /** A reconnect retires leases without touching the next connection's observers. */
  reset(): void {
    this.#retired = true;
    for (const entry of this.#entries) {
      for (const subscription of entry.handles) {
        const owner = sessionMessageSubscriptionOwners.get(subscription);
        if (owner?.coordinator === this) {
          this.#finishRelease(subscription, owner);
        }
      }
    }
    this.#entries.clear();
  }

  #createEntry(
    key: string,
    agentId: string | null,
    includeApprovals: boolean,
  ): SessionMessageSubscriptionEntry {
    const entry: SessionMessageSubscriptionEntry = {
      key,
      requestedKeys: new Set([key]),
      agentId,
      ready: Promise.resolve({ key }),
      approvalRequest: null,
      plainFallback: null,
      canonicalSettled: false,
      handles: new Set(),
      pendingOwners: 0,
      release: null,
    };
    entry.ready = this.#requestSubscribe(entry, includeApprovals);
    if (includeApprovals) {
      entry.ready = this.#trackApprovalRequest(entry, entry.ready);
    }
    // Concurrent owners observe the same rejection; this observer only prevents
    // an unhandled side branch and never changes the rejected acquire result.
    void entry.ready.catch(() => undefined);
    this.#entries.add(entry);
    return entry;
  }

  #acquireCapability(
    entry: SessionMessageSubscriptionEntry,
    includeApprovals: boolean,
  ): Promise<SessionMessageSubscriptionResponse> {
    if (!includeApprovals) {
      if (entry.approvalRequest === entry.ready) {
        if (!entry.plainFallback) {
          const approvalRequest = entry.ready;
          // Approval authorization is stronger than transcript observation.
          // A concurrent plain owner must retry without approvals if the
          // first approval-only request is rejected by the Gateway.
          entry.plainFallback = approvalRequest.catch(async (error: unknown) => {
            if (this.#retired) {
              throw error;
            }
            const result = await this.#requestSubscribe(entry, false);
            entry.ready = Promise.resolve(result);
            if (entry.approvalRequest === approvalRequest) {
              entry.approvalRequest = null;
            }
            return result;
          });
        }
        return entry.plainFallback;
      }
      return entry.ready;
    }
    if (entry.approvalRequest) {
      return entry.approvalRequest;
    }

    return this.#trackApprovalRequest(
      entry,
      entry.ready.then(() => this.#requestSubscribe(entry, true)),
    );
  }

  #trackApprovalRequest(
    entry: SessionMessageSubscriptionEntry,
    request: Promise<SessionMessageSubscriptionResponse>,
  ): Promise<SessionMessageSubscriptionResponse> {
    // Replays describe a moment in time. Share concurrent requests, but let
    // each later viewer retrieve the Gateway's current pending set.
    const tracked = request.finally(() => {
      if (entry.approvalRequest === tracked) {
        entry.approvalRequest = null;
      }
    });
    entry.approvalRequest = tracked;
    return tracked;
  }

  async #requestSubscribe(
    entry: SessionMessageSubscriptionEntry,
    includeApprovals: boolean,
  ): Promise<SessionMessageSubscriptionResponse> {
    const params = sessionSubscriptionParams(entry.key, entry.agentId);
    const result = await this.#client
      .request(
        "sessions.messages.subscribe",
        includeApprovals ? { ...params, includeApprovals: true } : params,
        { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
      )
      .catch(async (error: unknown) => {
        if (
          !(error instanceof GatewayProtocolRequestTimeoutError) ||
          !error.requestSent ||
          this.#retired
        ) {
          throw error;
        }
        try {
          // A sent request can commit before its acknowledgment. Restore only
          // capabilities still owned by acquired leases, including older approval panes.
          const retainedApprovals = [...entry.handles].some((handle) => handle.includeApprovals);
          await this.#client.request(
            entry.handles.size > 0
              ? "sessions.messages.subscribe"
              : "sessions.messages.unsubscribe",
            retainedApprovals ? { ...params, includeApprovals: true } : params,
            { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
          );
        } catch (recoveryError) {
          if (!this.#retired) {
            const subscriptionRecoveryFailure = new AggregateError(
              [error, recoveryError],
              "session message subscription recovery failed",
              { cause: recoveryError },
            );
            throw subscriptionRecoveryFailure;
          }
        }
        throw error;
      });
    const response = result && typeof result === "object" ? result : null;
    const responseKey = response && "key" in response ? response.key : undefined;
    entry.key =
      typeof responseKey === "string" && responseKey.trim() ? responseKey.trim() : entry.key;
    entry.canonicalSettled = true;
    return {
      key: entry.key,
      ...(response && "approvalReplay" in response
        ? { approvalReplay: response.approvalReplay }
        : {}),
    };
  }

  #finishRelease(
    subscription: GatewaySessionMessageSubscription,
    owner: SessionMessageSubscriptionOwner,
    removeEntry = false,
  ): void {
    if (sessionMessageSubscriptionOwners.get(subscription) !== owner) {
      return;
    }
    sessionMessageSubscriptionOwners.delete(subscription);
    owner.entry.handles.delete(subscription);
    if (removeEntry) {
      this.#entries.delete(owner.entry);
    }
  }

  #areKeysEquivalent(left: string, right: string): boolean {
    return left === right || this.#keysEquivalent?.(left, right) === true;
  }

  #couldShareCanonicalIdentity(left: string, right: string): boolean {
    const leftBody = left.replace(/^agent:[^:]+:/i, "").toLowerCase();
    const rightBody = right.replace(/^agent:[^:]+:/i, "").toLowerCase();
    // Main/global routing can replace its body with a configured alias. Folding
    // opaque peer IDs only over-serializes; it never merges distinct observers.
    return (
      leftBody === rightBody ||
      leftBody === "main" ||
      rightBody === "main" ||
      leftBody === "global" ||
      rightBody === "global"
    );
  }
}

const sessionMessageSubscriptionOwners = new WeakMap<
  GatewaySessionMessageSubscription,
  SessionMessageSubscriptionOwner
>();

const sessionMessageSubscriptionCoordinators = new WeakMap<
  GatewaySessionMessageRequestClient,
  GatewaySessionMessageSubscriptionCoordinator
>();

export function getGatewaySessionMessageSubscriptionCoordinator(
  client: GatewaySessionMessageRequestClient,
  options: GatewaySessionMessageSubscriptionCoordinatorOptions = {},
): GatewaySessionMessageSubscriptionCoordinator {
  const existing = sessionMessageSubscriptionCoordinators.get(client);
  if (existing) {
    return existing.configure(options);
  }
  const coordinator = new GatewaySessionMessageSubscriptionCoordinator(client, options);
  sessionMessageSubscriptionCoordinators.set(client, coordinator);
  return coordinator;
}

export function resetGatewaySessionMessageSubscriptionCoordinator(
  client: GatewaySessionMessageRequestClient,
): void {
  sessionMessageSubscriptionCoordinators.get(client)?.reset();
  sessionMessageSubscriptionCoordinators.delete(client);
}

export function releaseGatewaySessionMessageSubscription(
  subscription: GatewaySessionMessageSubscription,
): Promise<void> {
  return (
    sessionMessageSubscriptionOwners.get(subscription)?.coordinator.release(subscription) ??
    Promise.resolve()
  );
}
