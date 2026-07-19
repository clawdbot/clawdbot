import type { ReactiveController, ReactiveControllerHost } from "lit";
import { boardProviderForSession, type BoardProvider } from "./provider.ts";

type ProviderResolver = (sessionKey: string) => BoardProvider;

/** Keeps board-presence consumers reactive without coupling them to board content. */
export class BoardAvailabilityController implements ReactiveController {
  private readonly subscriptions = new Map<BoardProvider, () => void>();
  private connected = false;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly sessionKeys: () => readonly string[],
    private readonly resolveProvider: ProviderResolver = boardProviderForSession,
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
  }

  private synchronize(): void {
    if (!this.connected) {
      return;
    }
    const current = new Set(
      this.sessionKeys()
        .map((sessionKey) => sessionKey.trim())
        .filter(Boolean)
        .map((sessionKey) => this.resolveProvider(sessionKey)),
    );
    for (const [provider, unsubscribe] of this.subscriptions) {
      if (!current.has(provider)) {
        unsubscribe();
        this.subscriptions.delete(provider);
      }
    }
    for (const provider of current) {
      if (!this.subscriptions.has(provider)) {
        this.subscriptions.set(
          provider,
          provider.snapshot$.subscribe(() => this.host.requestUpdate()),
        );
      }
    }
  }
}
