// Control UI chat module implements pinned messages behavior.
import { PersistedSet } from "./persisted-set.ts";

const PREFIX = "openclaw:pinned:";

export class PinnedMessages extends PersistedSet<number> {
  constructor(sessionKey: string) {
    super(PREFIX + sessionKey, (value): value is number => typeof value === "number");
  }

  get indices(): Set<number> {
    return this.values;
  }

  pin(index: number): void {
    this.add(index);
  }

  unpin(index: number): void {
    this.remove(index);
  }

  toggle(index: number): void {
    if (this.has(index)) {
      this.unpin(index);
    } else {
      this.pin(index);
    }
  }
}
