export type BoardSnapshotSignal<T> = {
  readonly value: T;
  subscribe(listener: () => void): () => void;
};

export type BoardEventStream<T> = {
  subscribe(listener: (event: T) => void): () => void;
};

export class ValueSignal<T> implements BoardSnapshotSignal<T> {
  private readonly listeners = new Set<() => void>();

  constructor(public value: T) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  set(value: T): void {
    this.value = value;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export class EventStream<T> implements BoardEventStream<T> {
  private readonly listeners = new Set<(event: T) => void>();

  subscribe(listener: (event: T) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: T): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
