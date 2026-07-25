import type { Stats } from "node:fs";
import { isVolatileBackupPath } from "./backup-volatile-filter.js";

type VolatileFilterPlan = Parameters<typeof isVolatileBackupPath>[1];

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
  constructor(private readonly volatilePlan: VolatileFilterPlan) {
    super();
  }

  override get(key: string): Stats | undefined {
    const cached = super.get(key);
    if (cached) {
      return cached;
    }
    // node-tar consults this cache before lstat. Synthetic hits let known
    // volatile paths disappear during a live backup without aborting it.
    return isVolatileBackupPath(key, this.volatilePlan)
      ? VOLATILE_BACKUP_SYNTHETIC_STAT
      : undefined;
  }
}

export function createBackupVolatileStatCache(
  volatilePlan: VolatileFilterPlan,
): Map<string, Stats> {
  return new BackupVolatileStatCache(volatilePlan);
}
