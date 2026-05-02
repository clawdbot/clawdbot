import fs from "node:fs";
import path from "node:path";

const LOW_DISK_SPACE_WARNING_THRESHOLD_BYTES = 1024 * 1024 * 1024;

type DiskSpaceSnapshot = {
  targetPath: string;
  checkedPath: string;
  availableBytes: number;
  totalBytes: number | null;
};

function finiteNonNegativeNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : null;
}

function findExistingDiskSpacePath(targetPath: string): string | null {
  let current = path.resolve(targetPath);
  while (true) {
    try {
      const stats = fs.statSync(current);
      return stats.isDirectory() ? current : path.dirname(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  }
}

export function tryReadDiskSpace(targetPath: string): DiskSpaceSnapshot | null {
  if (typeof fs.statfsSync !== "function") {
    return null;
  }
  const checkedPath = findExistingDiskSpacePath(targetPath);
  if (!checkedPath) {
    return null;
  }
  try {
    const stats = fs.statfsSync(checkedPath);
    const blockSize = finiteNonNegativeNumber(stats.bsize);
    const availableBlocks = finiteNonNegativeNumber(stats.bavail);
    if (blockSize === null || availableBlocks === null) {
      return null;
    }
    const totalBlocks = finiteNonNegativeNumber(stats.blocks);
    return {
      targetPath,
      checkedPath,
      availableBytes: blockSize * availableBlocks,
      totalBytes: totalBlocks === null ? null : blockSize * totalBlocks,
    };
  } catch {
    return null;
  }
}

export function formatDiskSpaceBytes(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  if (mib < 1024) {
    return `${Math.max(0, Math.round(mib))} MiB`;
  }
  const gib = mib / 1024;
  return `${gib.toFixed(gib < 10 ? 1 : 0)} GiB`;
}

export function createLowDiskSpaceWarning(params: {
  targetPath: string;
  purpose: string;
  thresholdBytes?: number;
}): string | null {
  const thresholdBytes = params.thresholdBytes ?? LOW_DISK_SPACE_WARNING_THRESHOLD_BYTES;
  const snapshot = tryReadDiskSpace(params.targetPath);
  if (!snapshot || snapshot.availableBytes >= thresholdBytes) {
    return null;
  }
  const location =
    path.resolve(snapshot.targetPath) === path.resolve(snapshot.checkedPath)
      ? snapshot.checkedPath
      : `${snapshot.targetPath} (volume checked at ${snapshot.checkedPath})`;
  return `Low disk space near ${location}: ${formatDiskSpaceBytes(snapshot.availableBytes)} available; ${params.purpose} may fail.`;
}
