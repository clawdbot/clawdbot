/** Serializes adoption and departure for one physical browser meeting. */
export class MeetingSessionJoinLock {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.#tails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
      if (this.#tails.get(key) === tail) {
        this.#tails.delete(key);
      }
    }
  }
}
