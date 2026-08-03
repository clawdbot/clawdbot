// Control UI chat module implements deleted messages behavior.
import { PersistedSet } from "./persisted-set.ts";

const PREFIX = "openclaw:deleted:";

export class DeletedMessages extends PersistedSet<string> {
  constructor(sessionKey: string) {
    super(PREFIX + sessionKey, (value): value is string => typeof value === "string");
  }

  delete(key: string): void {
    this.add(key);
  }

  restore(key: string): void {
    this.remove(key);
  }
}
