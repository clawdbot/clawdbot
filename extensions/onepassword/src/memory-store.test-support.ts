import type {
  PluginStateEntry,
  PluginStateKeyedStore,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";

export class MemoryKeyedStore<T> implements PluginStateKeyedStore<T> {
  private readonly values = new Map<string, PluginStateEntry<T>>();

  constructor(private readonly now: () => number = Date.now) {}

  async register(key: string, value: T, opts?: { ttlMs?: number }): Promise<void> {
    const createdAt = this.now();
    this.values.set(key, {
      key,
      value,
      createdAt,
      ...(opts?.ttlMs ? { expiresAt: createdAt + opts.ttlMs } : {}),
    });
  }

  async registerIfAbsent(key: string, value: T, opts?: { ttlMs?: number }): Promise<boolean> {
    if (await this.lookup(key)) {
      return false;
    }
    await this.register(key, value, opts);
    return true;
  }

  async lookup(key: string): Promise<T | undefined> {
    const entry = this.values.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= this.now()) {
      this.values.delete(key);
      return undefined;
    }
    return entry?.value;
  }

  async consume(key: string): Promise<T | undefined> {
    const value = await this.lookup(key);
    this.values.delete(key);
    return value;
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async entries(): Promise<PluginStateEntry<T>[]> {
    for (const key of this.values.keys()) {
      await this.lookup(key);
    }
    return [...this.values.values()];
  }

  async clear(): Promise<void> {
    this.values.clear();
  }
}

export class MemorySyncKeyedStore<T> implements PluginStateSyncKeyedStore<T> {
  private readonly values = new Map<string, PluginStateEntry<T>>();

  constructor(private readonly now: () => number = Date.now) {}

  register(key: string, value: T, opts?: { ttlMs?: number }): void {
    const createdAt = this.now();
    this.values.set(key, {
      key,
      value,
      createdAt,
      ...(opts?.ttlMs ? { expiresAt: createdAt + opts.ttlMs } : {}),
    });
  }

  registerIfAbsent(key: string, value: T, opts?: { ttlMs?: number }): boolean {
    if (this.lookup(key)) {
      return false;
    }
    this.register(key, value, opts);
    return true;
  }

  lookup(key: string): T | undefined {
    const entry = this.values.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= this.now()) {
      this.values.delete(key);
      return undefined;
    }
    return entry?.value;
  }

  consume(key: string): T | undefined {
    const value = this.lookup(key);
    this.values.delete(key);
    return value;
  }

  delete(key: string): boolean {
    return this.values.delete(key);
  }

  entries(): PluginStateEntry<T>[] {
    for (const key of this.values.keys()) {
      this.lookup(key);
    }
    return [...this.values.values()];
  }

  clear(): void {
    this.values.clear();
  }
}
