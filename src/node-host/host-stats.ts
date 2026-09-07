import os from "node:os";
import type { NodeHostStatsPayload } from "../../packages/gateway-protocol/src/schema/nodes.js";
import { tryReadDiskSpace } from "../infra/disk-space.js";

function clampFinite(value: number, maximum = Number.MAX_SAFE_INTEGER): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(maximum, value)) : 0;
}

export function sampleNodeHostStats(): NodeHostStatsPayload {
  const memoryTotalBytes = Math.round(clampFinite(os.totalmem()));
  const memoryFreeBytes = Math.round(clampFinite(os.freemem(), memoryTotalBytes));
  const loads = os.loadavg();
  const loadAverage: [number, number, number] = [
    clampFinite(loads[0]!, 100_000),
    clampFinite(loads[1]!, 100_000),
    clampFinite(loads[2]!, 100_000),
  ];
  // Report the user's home volume, independent of the worker's current directory.
  const disk = tryReadDiskSpace(os.homedir());
  const diskTotalBytes =
    disk?.totalBytes == null ? undefined : Math.round(clampFinite(disk.totalBytes));
  return {
    cpuCount: Math.max(1, Math.min(4096, os.cpus().length)),
    ...(loadAverage.some((load) => load !== 0) ? { loadAverage } : {}),
    memoryTotalBytes,
    memoryFreeBytes,
    ...(disk && diskTotalBytes !== undefined
      ? {
          diskTotalBytes,
          diskAvailableBytes: Math.round(clampFinite(disk.availableBytes, diskTotalBytes)),
        }
      : {}),
  };
}
