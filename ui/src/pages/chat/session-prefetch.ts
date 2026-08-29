import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import { requestChatSessionSnapshot } from "./chat-history.ts";
import { MAX_CACHED_CHAT_SESSIONS } from "./session-cache.ts";
import {
  appendChatMessageToCache,
  cacheChatSessionSnapshot,
  readChatSessionSnapshot,
  type ChatMessageCache,
  type ChatSessionSnapshot,
} from "./session-message-cache.ts";
import { resolveChatSnapshotKey } from "./session-snapshot-invalidation.ts";
import type { SessionSnapshotStore } from "./session-snapshot-store.ts";

const SESSION_PREFETCH_COUNT = 5;
const SESSION_PREFETCH_INITIAL_DELAY_MS = 250;
const SESSION_PREFETCH_COOLDOWN_MS = 30_000;
const SESSION_PREFETCH_LOCK_NAME = "openclaw-chat-prefetch";

type ChatSnapshotKeyHost = Parameters<typeof resolveChatSnapshotKey>[0];

type SessionPrefetchSnapshot = {
  client: GatewayBrowserClient | null;
  listRevision: number;
  openSessionKeys: readonly string[];
  rows: readonly GatewaySessionRow[] | null;
  snapshotHost: ChatSnapshotKeyHost;
};

type SessionPrefetchCandidate = {
  activityAt: number;
  snapshotKey: string;
};

function sessionActivityAt(row: GatewaySessionRow): number {
  return row.lastActivityAt ?? row.updatedAt ?? 0;
}

function debugSessionPrefetch(message: string, error?: unknown): void {
  if (error === undefined) {
    console.debug(`[chat-session-prefetch] ${message}`);
  } else {
    console.debug(`[chat-session-prefetch] ${message}`, error);
  }
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

class SessionPrefetcher {
  private connected = false;
  private snapshot: SessionPrefetchSnapshot | null = null;
  private readonly lastAttemptAt = new Map<string, number>();
  private delayTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private idleTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private idleCallback: number | null = null;
  private running = false;
  private rescheduleDelayMs: number | null = null;

  constructor(
    private readonly cache: ChatMessageCache,
    private readonly snapshotStore: SessionSnapshotStore,
  ) {}

  connect(): void {
    if (this.connected) {
      return;
    }
    this.connected = true;
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.schedule();
  }

  disconnect(): void {
    this.connected = false;
    this.rescheduleDelayMs = null;
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.cancelScheduledWork();
  }

  update(snapshot: SessionPrefetchSnapshot): void {
    const previous = this.snapshot;
    this.snapshot = snapshot;
    if (
      !previous ||
      previous.client !== snapshot.client ||
      previous.listRevision !== snapshot.listRevision ||
      !sameKeys(previous.openSessionKeys, snapshot.openSessionKeys)
    ) {
      this.schedule();
    }
  }

  private readonly handleVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      this.schedule();
    }
  };

  private schedule(delayMs = SESSION_PREFETCH_INITIAL_DELAY_MS): void {
    if (!this.connected) {
      return;
    }
    if (this.running) {
      this.rescheduleDelayMs =
        this.rescheduleDelayMs === null ? delayMs : Math.min(this.rescheduleDelayMs, delayMs);
      return;
    }
    if (this.delayTimer !== null || this.idleTimer !== null || this.idleCallback !== null) {
      return;
    }
    this.delayTimer = globalThis.setTimeout(() => {
      this.delayTimer = null;
      this.scheduleIdleCycle();
    }, delayMs);
  }

  private scheduleIdleCycle(): void {
    if (!this.connected) {
      return;
    }
    if (typeof window.requestIdleCallback === "function") {
      this.idleCallback = window.requestIdleCallback(() => {
        this.idleCallback = null;
        void this.runCycle();
      });
      return;
    }
    this.idleTimer = globalThis.setTimeout(() => {
      this.idleTimer = null;
      void this.runCycle();
    }, 0);
  }

  private async runCycle(): Promise<void> {
    if (!this.connected || this.running || document.visibilityState === "hidden") {
      return;
    }
    this.running = true;
    try {
      const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
      if (locks) {
        await locks.request(SESSION_PREFETCH_LOCK_NAME, { ifAvailable: true }, async (lock) => {
          // ifAvailable must skip instead of queueing so one visible tab owns the cycle.
          if (lock) {
            await this.prefetchEligibleSessions();
          }
        });
      } else {
        await this.prefetchEligibleSessions();
      }
    } catch (error) {
      debugSessionPrefetch("cycle failed", error);
    } finally {
      this.running = false;
      if (this.rescheduleDelayMs !== null) {
        const delayMs = this.rescheduleDelayMs;
        this.rescheduleDelayMs = null;
        this.schedule(delayMs);
      }
    }
  }

  private async prefetchEligibleSessions(): Promise<void> {
    const snapshot = this.snapshot;
    if (
      !snapshot?.client ||
      !snapshot.rows ||
      document.visibilityState === "hidden" ||
      !this.connected
    ) {
      return;
    }
    const { client } = snapshot;
    await this.snapshotStore.loadSavedAtIndex();
    if (!this.isCurrent(snapshot)) {
      return;
    }
    // Refresh presented snapshots through their LRU owner before background writes
    // so a full cache evicts stale entries instead of visible conversation panes.
    for (const sessionKey of snapshot.openSessionKeys) {
      const presented = readChatSessionSnapshot(this.cache, snapshot.snapshotHost, { sessionKey });
      if (presented && this.cache.size === MAX_CACHED_CHAT_SESSIONS) {
        this.snapshotStore.write(
          resolveChatSnapshotKey(snapshot.snapshotHost, { sessionKey }),
          presented,
        );
      }
    }
    const selection = this.selectCandidates(snapshot);
    if (selection.deferMs !== null) {
      this.schedule(selection.deferMs);
    }
    await Promise.all(
      selection.candidates.map(async (candidate) => {
        if (!this.isCurrent(snapshot) || this.isOpen(candidate.snapshotKey, this.snapshot)) {
          return;
        }
        this.lastAttemptAt.set(candidate.snapshotKey, Date.now());
        try {
          let existing = readChatSessionSnapshot(this.cache, snapshot.snapshotHost, {
            sessionKey: candidate.snapshotKey,
          });
          if (!existing && this.snapshotStore.readSavedAt(candidate.snapshotKey) !== null) {
            existing = await this.snapshotStore.read(candidate.snapshotKey);
            if (!this.isCurrent(snapshot)) {
              return;
            }
            if (existing) {
              cacheChatSessionSnapshot(
                this.cache,
                snapshot.snapshotHost,
                { sessionKey: candidate.snapshotKey },
                existing,
              );
            }
          }
          let result = await requestChatSessionSnapshot(
            client,
            candidate.snapshotKey,
            this,
            () => this.isCurrent(snapshot),
            existing?.deltaCursor,
          );
          if (!this.isCurrent(snapshot)) {
            return;
          }
          if (result.kind === "reset") {
            if (existing?.deltaCursor !== undefined) {
              const { deltaCursor: _deltaCursor, ...withoutCursor } = existing;
              cacheChatSessionSnapshot(
                this.cache,
                snapshot.snapshotHost,
                { sessionKey: candidate.snapshotKey },
                withoutCursor,
              );
              existing = withoutCursor;
            }
            result = await requestChatSessionSnapshot(client, candidate.snapshotKey, this, () =>
              this.isCurrent(snapshot),
            );
            if (!this.isCurrent(snapshot)) {
              return;
            }
          }
          if (
            this.isOpen(candidate.snapshotKey, this.snapshot) ||
            this.currentActivityAt(candidate.snapshotKey) > candidate.activityAt
          ) {
            return;
          }
          let cached: ChatSessionSnapshot;
          if (result.kind === "delta") {
            for (const payload of result.messages) {
              const event = asOptionalRecord(payload);
              if (!event || !Object.hasOwn(event, "message")) {
                continue;
              }
              appendChatMessageToCache(
                this.cache,
                snapshot.snapshotHost,
                { sessionKey: candidate.snapshotKey },
                event.message,
                event,
              );
            }
            const updated = readChatSessionSnapshot(this.cache, snapshot.snapshotHost, {
              sessionKey: candidate.snapshotKey,
            });
            if (!updated) {
              return;
            }
            cached = {
              ...updated,
              // Prefetch does not own transient run replay. Keep the prior cursor
              // so the opening pane can consume the same authoritative snapshot.
              ...(result.inFlightRun ? {} : { deltaCursor: result.deltaCursor }),
              ...(Object.hasOwn(result.sessionInfo, "activeLeafEntryId")
                ? { displayedLeafEntryId: result.sessionInfo.activeLeafEntryId?.trim() || null }
                : {}),
              sessionId: result.sessionInfo.sessionId?.trim() || updated.sessionId,
            };
          } else if (result.kind === "snapshot") {
            cached = result.snapshot;
          } else {
            throw new Error("chat history page request returned a cursor reset");
          }
          cacheChatSessionSnapshot(
            this.cache,
            snapshot.snapshotHost,
            { sessionKey: candidate.snapshotKey },
            cached,
          );
        } catch (error) {
          debugSessionPrefetch(`history fetch failed for ${candidate.snapshotKey}`, error);
        }
      }),
    );
  }

  private selectCandidates(snapshot: SessionPrefetchSnapshot): {
    candidates: SessionPrefetchCandidate[];
    deferMs: number | null;
  } {
    const openKeys = new Set(
      snapshot.openSessionKeys.map((sessionKey) =>
        resolveChatSnapshotKey(snapshot.snapshotHost, { sessionKey }),
      ),
    );
    const maxPrefetchedSessions = Math.max(0, MAX_CACHED_CHAT_SESSIONS - openKeys.size);
    const rows = (snapshot.rows ?? []).toSorted(
      (left, right) => sessionActivityAt(right) - sessionActivityAt(left),
    );
    const candidates: SessionPrefetchCandidate[] = [];
    const seen = new Set<string>();
    let deferMs: number | null = null;
    for (const row of rows) {
      // The presented pane owns transient run adoption and replay. Background
      // prefetch only warms durable history, so it must not consume active state.
      if (isSessionRunActive(row)) {
        continue;
      }
      const snapshotKey = resolveChatSnapshotKey(snapshot.snapshotHost, {
        sessionKey: row.key,
        agentId: row.agentId,
      });
      if (openKeys.has(snapshotKey) || seen.has(snapshotKey)) {
        continue;
      }
      seen.add(snapshotKey);
      // Warming older rows must never evict hotter or presented snapshots.
      if (seen.size > maxPrefetchedSessions) {
        break;
      }
      const activityAt = sessionActivityAt(row);
      const savedAt = this.snapshotStore.readSavedAt(snapshotKey);
      if (savedAt !== null && savedAt >= activityAt) {
        continue;
      }
      const elapsed = Date.now() - (this.lastAttemptAt.get(snapshotKey) ?? 0);
      if (elapsed < SESSION_PREFETCH_COOLDOWN_MS) {
        const remaining = SESSION_PREFETCH_COOLDOWN_MS - elapsed;
        deferMs = deferMs === null ? remaining : Math.min(deferMs, remaining);
        continue;
      }
      candidates.push({ activityAt, snapshotKey });
      if (candidates.length === SESSION_PREFETCH_COUNT) {
        break;
      }
    }
    return { candidates, deferMs };
  }

  private isCurrent(snapshot: SessionPrefetchSnapshot): boolean {
    return (
      this.connected &&
      document.visibilityState !== "hidden" &&
      this.snapshot?.client === snapshot.client &&
      this.snapshot.listRevision === snapshot.listRevision
    );
  }

  private isOpen(snapshotKey: string, snapshot: SessionPrefetchSnapshot | null): boolean {
    return Boolean(
      snapshot?.openSessionKeys.some(
        (sessionKey) =>
          resolveChatSnapshotKey(snapshot.snapshotHost, { sessionKey }) === snapshotKey,
      ),
    );
  }

  private currentActivityAt(snapshotKey: string): number {
    const snapshot = this.snapshot;
    if (!snapshot?.rows) {
      return 0;
    }
    let activityAt = 0;
    for (const row of snapshot.rows) {
      const rowSnapshotKey = resolveChatSnapshotKey(snapshot.snapshotHost, {
        sessionKey: row.key,
        agentId: row.agentId,
      });
      if (rowSnapshotKey === snapshotKey) {
        activityAt = Math.max(activityAt, sessionActivityAt(row));
      }
    }
    return activityAt;
  }

  private cancelScheduledWork(): void {
    if (this.delayTimer !== null) {
      globalThis.clearTimeout(this.delayTimer);
      this.delayTimer = null;
    }
    if (this.idleTimer !== null) {
      globalThis.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.idleCallback !== null) {
      window.cancelIdleCallback(this.idleCallback);
      this.idleCallback = null;
    }
  }
}

type SessionPrefetchHost = ReactiveControllerHost & ParentNode;

class SessionPrefetchController implements ReactiveController {
  private readonly prefetcher: SessionPrefetcher;
  private context: ApplicationContext | undefined;
  private subscriptions: Array<() => void> = [];

  constructor(
    private readonly host: SessionPrefetchHost,
    cache: ChatMessageCache,
    snapshotStore: SessionSnapshotStore,
    private readonly readContext: () => ApplicationContext | undefined,
  ) {
    this.prefetcher = new SessionPrefetcher(cache, snapshotStore);
    host.addController(this);
  }

  hostConnected(): void {
    this.prefetcher.connect();
    this.sync();
  }

  hostUpdated(): void {
    this.sync();
  }

  hostDisconnected(): void {
    this.clearSubscriptions();
    this.prefetcher.disconnect();
  }

  private readonly sync = () => {
    const context = this.readContext();
    if (context !== this.context) {
      this.clearSubscriptions();
      this.context = context;
      if (context) {
        this.subscriptions = [context.gateway.subscribe(this.sync)];
      }
    }
    if (!context) {
      return;
    }
    const panes = this.host.querySelectorAll<Element & { sessionKey?: string }>(
      "openclaw-chat-pane",
    );
    const openSessionKeys = [...panes].flatMap((pane) =>
      pane.sessionKey ? [pane.sessionKey] : [],
    );
    this.prefetcher.update({
      client:
        context.gateway.snapshot.phase === "connected" ? context.gateway.snapshot.client : null,
      listRevision: context.sessions.canonicalListRevision,
      openSessionKeys,
      rows: context.sessions.state.result?.sessions ?? null,
      snapshotHost: {
        assistantAgentId: context.gateway.snapshot.assistantAgentId,
        agentsList: context.agents.state.agentsList,
        hello: context.gateway.snapshot.hello,
      },
    });
  };

  private clearSubscriptions(): void {
    for (const unsubscribe of this.subscriptions) {
      unsubscribe();
    }
    this.subscriptions = [];
    this.context = undefined;
  }
}

export function installSessionPrefetch(
  host: SessionPrefetchHost,
  cache: ChatMessageCache,
  snapshotStore: SessionSnapshotStore,
  readContext: () => ApplicationContext | undefined,
): ReactiveController {
  return new SessionPrefetchController(host, cache, snapshotStore, readContext);
}
