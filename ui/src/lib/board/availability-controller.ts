import type { BoardChangedEvent, BoardSnapshot } from "@openclaw/gateway-protocol";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  boardExists,
  boardProviderCacheKey,
  boardProviderForSession,
  clearSessionBoardAvailability,
  recordSessionBoardAvailability,
  type BoardProvider,
} from "./provider.ts";

type ProviderResolver = (sessionKey: string) => BoardProvider;
type AvailabilityClient = Pick<GatewayBrowserClient, "request" | "addEventListener">;
type AvailabilitySource = {
  client: AvailabilityClient | null;
  connected: boolean;
  available: boolean;
  key: string;
};
type SourceResolver = () => AvailabilitySource;

const disconnectedSource: SourceResolver = () => ({
  client: null,
  connected: false,
  available: false,
  key: "",
});

/** Keeps board-presence consumers reactive without creating a provider per sidebar row. */
export class BoardAvailabilityController implements ReactiveController {
  private readonly subscriptions = new Map<BoardProvider, () => void>();
  private readonly lookupGeneration = new Map<string, number>();
  private lookupSequence = 0;
  private readonly lookedUpSessions = new Set<string>();
  private readonly retryDelay = new Map<string, number>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private visibleSessionKeys = new Set<string>();
  private sourceClient: AvailabilityClient | null = null;
  private sourceKey = "";
  private sourceUnsubscribe: (() => void) | undefined;
  private sourceActive = false;
  private available = false;
  private connected = false;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly sessionKeys: () => readonly string[],
    private readonly resolveProvider: ProviderResolver = boardProviderForSession,
    private readonly resolveSource: SourceResolver = disconnectedSource,
  ) {
    host.addController(this);
  }

  hostConnected(): void {
    this.connected = true;
    this.synchronize();
  }

  hostUpdate(): void {
    this.synchronize();
  }

  hostDisconnected(): void {
    this.connected = false;
    for (const unsubscribe of this.subscriptions.values()) {
      unsubscribe();
    }
    this.subscriptions.clear();
    this.disconnectSource();
    this.visibleSessionKeys.clear();
  }

  private synchronize(): void {
    if (!this.connected) {
      return;
    }
    const keys = new Set(
      this.sessionKeys()
        .map((sessionKey) => sessionKey.trim())
        .filter(Boolean)
        .map(boardProviderCacheKey),
    );
    const currentProviders = new Set(
      [...keys].map((sessionKey) => this.resolveProvider(sessionKey)),
    );
    for (const [provider, unsubscribe] of this.subscriptions) {
      if (!currentProviders.has(provider)) {
        unsubscribe();
        this.subscriptions.delete(provider);
      }
    }
    for (const provider of currentProviders) {
      if (!this.subscriptions.has(provider)) {
        this.subscriptions.set(
          provider,
          provider.snapshot$.subscribe(() => this.host.requestUpdate()),
        );
      }
    }

    for (const previous of this.visibleSessionKeys) {
      if (!keys.has(previous)) {
        this.lookedUpSessions.delete(previous);
        this.lookupGeneration.delete(previous);
        this.clearRetry(previous);
      }
    }
    this.visibleSessionKeys = keys;
    this.synchronizeSource();
    if (this.sourceActive && this.sourceClient) {
      for (const sessionKey of keys) {
        if (!this.lookedUpSessions.has(sessionKey)) {
          this.lookedUpSessions.add(sessionKey);
          this.lookup(sessionKey, this.sourceClient);
        }
      }
    }
  }

  private synchronizeSource(): void {
    const source = this.resolveSource();
    const active = source.connected && source.available && source.client !== null;
    if (
      this.sourceClient === source.client &&
      this.sourceActive === active &&
      this.available === source.available &&
      this.sourceKey === source.key
    ) {
      return;
    }
    const availabilitySourceChanged =
      this.sourceClient !== source.client || this.sourceKey !== source.key || !source.available;
    this.disconnectSource();
    this.sourceClient = source.client;
    this.sourceActive = active;
    this.available = source.available;
    this.sourceKey = source.key;
    if (availabilitySourceChanged && clearSessionBoardAvailability()) {
      this.host.requestUpdate();
    }
    if (!active || !source.client) {
      return;
    }
    const client = source.client;
    this.sourceUnsubscribe = client.addEventListener((event) => {
      if (event.event !== "board.changed") {
        return;
      }
      const payload = event.payload as Partial<BoardChangedEvent> | undefined;
      const sessionKey =
        typeof payload?.sessionKey === "string"
          ? boardProviderCacheKey(payload.sessionKey)
          : undefined;
      if (sessionKey && this.visibleSessionKeys.has(sessionKey)) {
        this.clearRetry(sessionKey);
        this.lookup(sessionKey, client);
      }
    });
  }

  private disconnectSource(): void {
    this.sourceUnsubscribe?.();
    this.sourceUnsubscribe = undefined;
    this.sourceClient = null;
    this.sourceActive = false;
    this.available = false;
    this.lookedUpSessions.clear();
    this.lookupGeneration.clear();
    for (const sessionKey of this.retryTimers.keys()) {
      this.clearRetry(sessionKey);
    }
  }

  private lookup(sessionKey: string, client: AvailabilityClient): void {
    const generation = ++this.lookupSequence;
    this.lookupGeneration.set(sessionKey, generation);
    void client
      .request<BoardSnapshot>("board.get", { sessionKey })
      .then((snapshot) => {
        if (
          !this.connected ||
          !this.sourceActive ||
          this.sourceClient !== client ||
          this.lookupGeneration.get(sessionKey) !== generation ||
          !this.visibleSessionKeys.has(sessionKey)
        ) {
          return;
        }
        if (recordSessionBoardAvailability(sessionKey, boardExists(snapshot))) {
          this.host.requestUpdate();
        }
        this.clearRetry(sessionKey);
      })
      .catch(() => {
        if (
          this.sourceClient === client &&
          this.lookupGeneration.get(sessionKey) === generation &&
          this.visibleSessionKeys.has(sessionKey)
        ) {
          this.scheduleRetry(sessionKey, client);
        }
      });
  }

  private scheduleRetry(sessionKey: string, client: AvailabilityClient): void {
    if (this.retryTimers.has(sessionKey)) {
      return;
    }
    const delay = this.retryDelay.get(sessionKey) ?? 1_000;
    const timer = setTimeout(() => {
      this.retryTimers.delete(sessionKey);
      if (
        this.connected &&
        this.sourceActive &&
        this.sourceClient === client &&
        this.visibleSessionKeys.has(sessionKey)
      ) {
        this.lookup(sessionKey, client);
      }
    }, delay);
    this.retryTimers.set(sessionKey, timer);
    this.retryDelay.set(sessionKey, Math.min(delay * 2, 30_000));
  }

  private clearRetry(sessionKey: string): void {
    const timer = this.retryTimers.get(sessionKey);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(sessionKey);
    }
    this.retryDelay.delete(sessionKey);
  }
}
