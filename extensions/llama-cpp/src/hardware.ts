import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveLlamaCppDataDir } from "./defaults.js";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

type LlamaCppAccelerator =
  | { kind: "metal" }
  | { kind: "cpu"; reason: string }
  | {
      kind: "cuda";
      devices: Array<{
        name: string;
        totalMemoryBytes: number;
        availableMemoryBytes: number;
        driverVersion: string;
        computeCapability?: number;
      }>;
    };

export type LlamaCppHardware = {
  platform: NodeJS.Platform;
  arch: string;
  totalMemoryBytes: number;
  availableMemoryBytes: number;
  availableDiskBytes?: number;
  availableRuntimeDiskBytes?: number;
  sharedDisk: boolean;
  accelerator: LlamaCppAccelerator;
};

async function runHardwareProbe(
  command: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    return await new Promise<string>((resolve, reject) => {
      execFile(
        command,
        args,
        {
          encoding: "utf8",
          timeout: 3_000,
          maxBuffer: 64 * 1024,
          signal,
        },
        (error: Error | null, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
}

async function readAvailableMemory(
  platform: NodeJS.Platform,
  signal?: AbortSignal,
): Promise<number> {
  if (platform === "linux") {
    const meminfo = await fs.readFile("/proc/meminfo", "utf8").catch(() => "");
    const available = /^MemAvailable:\s+(\d+)\s+kB$/mu.exec(meminfo)?.[1];
    if (available) {
      return Number(available) * 1024;
    }
  }
  if (platform === "darwin") {
    const vmstat = await runHardwareProbe("/usr/bin/vm_stat", [], signal);
    const pageSize = /page size of (\d+) bytes/u.exec(vmstat ?? "")?.[1];
    const free = /^Pages free:\s+(\d+)\./mu.exec(vmstat ?? "")?.[1];
    const inactive = /^Pages inactive:\s+(\d+)\./mu.exec(vmstat ?? "")?.[1];
    if (pageSize && free && inactive) {
      // Inactive pages are reclaimable; os.freemem alone mistakes file cache for pressure.
      // Purgeable pages overlap these categories and must not be counted twice.
      return (Number(free) + Number(inactive)) * Number(pageSize);
    }
  }
  return os.freemem();
}

async function readAvailableDisk(
  cacheDir: string,
  platform: NodeJS.Platform,
  signal?: AbortSignal,
): Promise<{ availableBytes: number; capacityGroup?: string } | undefined> {
  let directory = path.resolve(cacheDir);
  while (true) {
    try {
      const [capacity, stat] = await Promise.all([fs.statfs(directory), fs.stat(directory)]);
      let capacityGroup: string | undefined = `device:${stat.dev}`;
      // Linux magic.h identifies ext2/3/4, XFS, and F2FS device filesystems.
      // Pooled/layered filesystems (including Btrfs subvolumes) can share capacity
      // across device IDs; leave their allocation group unknown.
      if (platform === "linux" && ![0xef53, 0x58465342, 0xf2f52010].includes(capacity.type)) {
        capacityGroup = undefined;
      }
      if (platform === "darwin") {
        // APFS volumes have distinct device IDs but share their container's free space.
        // diskutil accepts a device or mount point, not an arbitrary cache directory.
        const disk = /^\/dev\/(disk\d+(?:s\d+)*)\s/mu.exec(
          (await runHardwareProbe("/bin/df", ["-P", directory], signal)) ?? "",
        )?.[1];
        const info = disk
          ? await runHardwareProbe("/usr/sbin/diskutil", ["info", "-plist", disk], signal)
          : undefined;
        const container = /<key>APFSContainerReference<\/key>\s*<string>(disk\d+)<\/string>/u.exec(
          info ?? "",
        )?.[1];
        const filesystem = /<key>FilesystemType<\/key>\s*<string>([^<]+)<\/string>/u.exec(
          info ?? "",
        )?.[1];
        capacityGroup = container
          ? `apfs:${container}`
          : filesystem && filesystem !== "apfs"
            ? capacityGroup
            : undefined;
      }
      return { availableBytes: capacity.bavail * capacity.bsize, capacityGroup };
    } catch (error) {
      signal?.throwIfAborted();
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      const parent = path.dirname(directory);
      if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === directory) {
        return undefined;
      }
      directory = parent;
    }
  }
}

async function readAccelerator(
  platform: NodeJS.Platform,
  arch: string,
  signal?: AbortSignal,
): Promise<LlamaCppAccelerator> {
  if (platform === "darwin" && arch === "arm64") {
    return { kind: "metal" };
  }
  if (platform !== "linux" && platform !== "win32") {
    return { kind: "cpu", reason: "No managed GPU backend is available for this host." };
  }
  const output = await runHardwareProbe(
    "nvidia-smi",
    [
      "--query-gpu=name,memory.total,memory.free,driver_version,compute_cap",
      "--format=csv,noheader,nounits",
    ],
    signal,
  );
  const devices = (output?.trim().split(/\r?\n/u) ?? []).slice(0, 32).flatMap((line) => {
    const fields = line.split(",").map((field) => field.trim());
    const [total, available, driverVersion, compute] = fields.slice(-4);
    const name = fields.slice(0, -4).join(", ");
    const totalMemoryBytes = Number(total) * MIB;
    const availableMemoryBytes = Number(available) * MIB;
    const computeCapability = Number(compute);
    if (
      !name ||
      !driverVersion ||
      !/^\d+(?:\.\d+)+$/u.test(driverVersion) ||
      !Number.isFinite(totalMemoryBytes) ||
      !Number.isFinite(availableMemoryBytes) ||
      totalMemoryBytes <= 0 ||
      availableMemoryBytes < 0 ||
      availableMemoryBytes > totalMemoryBytes
    ) {
      return [];
    }
    return [
      {
        name,
        totalMemoryBytes,
        availableMemoryBytes,
        driverVersion,
        ...(Number.isFinite(computeCapability) && computeCapability > 0
          ? { computeCapability }
          : {}),
      },
    ];
  });
  return devices.length > 0
    ? { kind: "cuda", devices }
    : { kind: "cpu", reason: "nvidia-smi did not report a usable NVIDIA GPU." };
}

/** Read the Gateway host once during setup; never probe on inference requests. */
export async function detectLlamaCppHardware(params: {
  cacheDir: string;
  signal?: AbortSignal;
}): Promise<LlamaCppHardware> {
  params.signal?.throwIfAborted();
  const platform = os.platform();
  const arch = os.arch();
  const hostMemoryBytes = os.totalmem();
  const constrainedMemory = process.constrainedMemory();
  const constrained = constrainedMemory > 0 && constrainedMemory < hostMemoryBytes;
  const totalMemoryBytes = constrained ? constrainedMemory : hostMemoryBytes;
  const [availableMemory, modelDisk, runtimeDisk, accelerator] = await Promise.all([
    readAvailableMemory(platform, params.signal),
    readAvailableDisk(params.cacheDir, platform, params.signal),
    readAvailableDisk(resolveLlamaCppDataDir(), platform, params.signal),
    readAccelerator(platform, arch, params.signal),
  ]);
  params.signal?.throwIfAborted();
  return {
    platform,
    arch,
    totalMemoryBytes,
    availableMemoryBytes: Math.min(
      totalMemoryBytes,
      availableMemory,
      constrained ? process.availableMemory() : totalMemoryBytes,
    ),
    availableDiskBytes: modelDisk?.availableBytes,
    availableRuntimeDiskBytes: runtimeDisk?.availableBytes,
    // Unknown allocation groups retain the combined reserve instead of counting
    // potentially shared free space twice.
    sharedDisk:
      !modelDisk?.capacityGroup ||
      !runtimeDisk?.capacityGroup ||
      modelDisk.capacityGroup === runtimeDisk.capacityGroup,
    accelerator,
  };
}

export function formatLlamaCppMemory(bytes: number): string {
  return `${(bytes / GIB).toFixed(1).replace(/\.0$/u, "")} GiB`;
}
