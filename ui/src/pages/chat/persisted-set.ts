import { getSafeLocalStorage } from "../../local-storage.ts";

export class PersistedSet<T> {
  protected values = new Set<T>();

  constructor(
    private readonly key: string,
    isValue: (value: unknown) => value is T,
  ) {
    try {
      const parsed: unknown = JSON.parse(getSafeLocalStorage()?.getItem(key) ?? "");
      if (Array.isArray(parsed)) {
        this.values = new Set(parsed.filter(isValue));
      }
    } catch {
      // Storage is optional and corrupt entries are ignored.
    }
  }

  has(value: T): boolean {
    return this.values.has(value);
  }

  protected add(value: T): void {
    this.values.add(value);
    this.save();
  }

  protected remove(value: T): void {
    this.values.delete(value);
    this.save();
  }

  clear(): void {
    this.values.clear();
    this.save();
  }

  private save(): void {
    try {
      getSafeLocalStorage()?.setItem(this.key, JSON.stringify([...this.values]));
    } catch {
      // Storage is optional.
    }
  }
}
