import type { Stats } from "node:fs";

type BackupLinkCacheKey = `${number}:${number}`;

const VOLATILE_BACKUP_SYNTHETIC_STAT = {
  isBlockDevice: () => false,
  isCharacterDevice: () => false,
  isDirectory: () => false,
  isFIFO: () => false,
  isFile: () => false,
  isSocket: () => false,
  isSymbolicLink: () => false,
} as unknown as Stats;

class BackupVolatileStatCache extends Map<string, Stats> {
  constructor(private readonly isVolatilePath: (sourcePath: string) => boolean) {
    super();
  }

  override get(key: string): Stats | undefined {
    const cached = super.get(key);
    if (cached) {
      return cached;
    }
    // node-tar consults this cache before lstat. Synthetic hits let known
    // volatile paths disappear during a live backup without aborting it.
    return this.isVolatilePath(key) ? VOLATILE_BACKUP_SYNTHETIC_STAT : undefined;
  }
}

// node-tar emits hardlink entries when this cache returns an earlier inode path.
// Suppressing both reads and writes keeps every backup entry independently restorable.
class BackupLinkCache extends Map<BackupLinkCacheKey, string> {
  override get(_key: BackupLinkCacheKey): undefined {
    return undefined;
  }

  override set(_key: BackupLinkCacheKey, _value: string): this {
    return this;
  }
}

export function createBackupVolatileStatCache(
  isVolatilePath: (sourcePath: string) => boolean,
): Map<string, Stats> {
  return new BackupVolatileStatCache(isVolatilePath);
}

export function createBackupLinkCache(): Map<BackupLinkCacheKey, string> {
  return new BackupLinkCache();
}
