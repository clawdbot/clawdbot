// Control UI chat module implements pinned messages behavior.
import { getSafeLocalStorage } from "../../local-storage.ts";

const PREFIX = "openclaw:pinned:";

export class PinnedMessages {
  private key: string;
  private pinnedIndices = new Set<number>();

  constructor(sessionKey: string) {
    this.key = PREFIX + sessionKey;
    this.load();
  }

  get indices(): Set<number> {
    return this.pinnedIndices;
  }

  has(index: number): boolean {
    return this.pinnedIndices.has(index);
  }

  pin(index: number): void {
    this.pinnedIndices.add(index);
    this.save();
  }

  unpin(index: number): void {
    this.pinnedIndices.delete(index);
    this.save();
  }

  toggle(index: number): void {
    if (this.pinnedIndices.has(index)) {
      this.unpin(index);
    } else {
      this.pin(index);
    }
  }

  clear(): void {
    this.pinnedIndices.clear();
    this.save();
  }

  private load(): void {
    try {
      const raw = getSafeLocalStorage()?.getItem(this.key);
      if (!raw) {
        return;
      }
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        this.pinnedIndices = new Set(arr.filter((n) => typeof n === "number"));
      }
    } catch {
      // ignore
    }
  }

  private save(): void {
    try {
      getSafeLocalStorage()?.setItem(this.key, JSON.stringify([...this.pinnedIndices]));
    } catch {
      // ignore
    }
  }
}
