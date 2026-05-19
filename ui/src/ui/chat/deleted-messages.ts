import { getSafeLocalStorage } from "../../local-storage.ts";

const PREFIX = "openclaw:deleted:";

export class DeletedMessages {
  private key: string;
  private keys = new Set<string>();

  constructor(sessionKey: string) {
    this.key = PREFIX + sessionKey;
    this.load();
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  delete(key: string): void {
    this.keys.add(key);
    this.save();
  }

  restore(key: string): void {
    this.keys.delete(key);
    this.save();
  }

  clear(): void {
    this.keys.clear();
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
        this.keys = new Set(arr.filter((s) => typeof s === "string"));
      }
    } catch {
      // ignore
    }
  }

  private save(): void {
    try {
      getSafeLocalStorage()?.setItem(this.key, JSON.stringify([...this.keys]));
    } catch {
      // ignore
    }
  }
}
