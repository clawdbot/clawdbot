import type { ChannelDirectoryEntryKind, ChannelId } from "../../channels/plugins/types.js";
import type { MoltbotConfig } from "../../config/config.js";

type CacheEntry<T> = {
  value: T;
  fetchedAt: number;
};

export type DirectoryCacheKey = {
  channel: ChannelId;
  accountId?: string | null;
  kind: ChannelDirectoryEntryKind;
  source: "cache" | "live";
  signature?: string | null;
};

export function buildDirectoryCacheKey(key: DirectoryCacheKey): string {
  const signature = key.signature ?? "default";
  return `${key.channel}:${key.accountId ?? "default"}:${key.kind}:${key.source}:${signature}`;
}

export class DirectoryCache<T> {
  private readonly cache = new Map<string, CacheEntry<T>>();
  private lastConfigRef: MoltbotConfig | null = null;

  constructor(private readonly ttlMs: number) {}

  get(key: string, cfg: MoltbotConfig): T | undefined {
    this.resetIfConfigChanged(cfg);
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.fetchedAt > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, cfg: MoltbotConfig): void {
    this.resetIfConfigChanged(cfg);
    this.cache.set(key, { value, fetchedAt: Date.now() });
  }

  clearMatching(match: (key: string) => boolean): void {
    for (const key of this.cache.keys()) {
      if (match(key)) this.cache.delete(key);
    }
  }

  clear(cfg?: MoltbotConfig): void {
    this.cache.clear();
    if (cfg) this.lastConfigRef = cfg;
  }

  private resetIfConfigChanged(cfg: MoltbotConfig): void {
    if (this.lastConfigRef && this.lastConfigRef !== cfg) {
      this.cache.clear();
    }
    this.lastConfigRef = cfg;
  }
}
