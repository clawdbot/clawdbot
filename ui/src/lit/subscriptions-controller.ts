import type { ReactiveController, ReactiveControllerHost } from "lit";

type Cleanup = () => void;

type SourceEntry<T> = {
  readonly getSource: () => T | null | undefined;
  readonly connect: (source: T) => Cleanup | undefined;
  readonly invalidateOnConnect: boolean;
  source: T | undefined;
  cleanup: Cleanup | undefined;
  generation: number;
};

/**
 * Owns subscriptions whose sources can arrive or change after connection.
 * Source identity is checked before every render and all cleanup follows the
 * host lifecycle, so consumers do not need connected/updated retry loops.
 */
export class SubscriptionsController implements ReactiveController {
  private readonly entries: SourceEntry<unknown>[] = [];
  private connected = false;

  constructor(private readonly host: ReactiveControllerHost) {
    host.addController(this);
  }

  watch<T>(
    getSource: () => T | null | undefined,
    subscribe: (source: T, notify: () => void) => Cleanup,
    synchronize?: (source: T) => void,
  ): this {
    return this.addEntry(
      getSource,
      (source, entry) => {
        const generation = entry.generation;
        const notify = () => {
          if (
            !this.connected ||
            entry.generation !== generation ||
            !Object.is(entry.source, source)
          ) {
            return;
          }
          synchronize?.(source);
          this.host.requestUpdate();
        };
        const cleanup = subscribe(source, notify);
        // Make cleanup visible before synchronization in case initial state
        // projection throws after the external listener is already registered.
        entry.cleanup = cleanup;
        synchronize?.(source);
        return cleanup;
      },
      true,
    );
  }

  effect<T>(
    getSource: () => T | null | undefined,
    connect: (source: T) => Cleanup | undefined,
  ): this {
    return this.addEntry(getSource, (source) => connect(source), false);
  }

  hostConnected(): void {
    this.connected = true;
    this.refresh(true);
  }

  hostUpdate(): void {
    if (this.connected) {
      this.refresh(false);
    }
  }

  clear(): void {
    for (const entry of this.entries) {
      this.disconnectEntry(entry);
    }
  }

  hostDisconnected(): void {
    this.connected = false;
    this.clear();
  }

  private addEntry<T>(
    getSource: () => T | null | undefined,
    connect: (source: T, entry: SourceEntry<T>) => Cleanup | undefined,
    invalidateOnConnect: boolean,
  ): this {
    const entry: SourceEntry<T> = {
      getSource,
      connect: (source) => connect(source, entry),
      invalidateOnConnect,
      source: undefined,
      cleanup: undefined,
      generation: 0,
    };
    this.entries.push(entry as SourceEntry<unknown>);
    if (this.connected) {
      this.refreshEntry(entry, invalidateOnConnect);
    }
    return this;
  }

  private refresh(requestUpdate: boolean): void {
    for (const entry of this.entries) {
      this.refreshEntry(entry, requestUpdate && entry.invalidateOnConnect);
    }
  }

  private refreshEntry<T>(entry: SourceEntry<T>, requestUpdate: boolean): void {
    const source = entry.getSource() ?? undefined;
    if (Object.is(entry.source, source)) {
      return;
    }
    this.disconnectEntry(entry);
    if (source === undefined) {
      return;
    }
    entry.source = source;
    entry.generation += 1;
    try {
      entry.cleanup = entry.connect(source);
    } catch (error) {
      this.disconnectEntry(entry);
      throw error;
    }
    if (requestUpdate) {
      this.host.requestUpdate();
    }
  }

  private disconnectEntry<T>(entry: SourceEntry<T>): void {
    entry.generation += 1;
    entry.source = undefined;
    const cleanup = entry.cleanup;
    entry.cleanup = undefined;
    if (!cleanup) {
      return;
    }
    try {
      cleanup();
    } catch (error) {
      console.error("[openclaw] subscription cleanup failed", error);
    }
  }
}
