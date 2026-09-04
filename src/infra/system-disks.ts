import fs from "node:fs/promises";
import os from "node:os";
import { decodeMountInfoPath } from "@openclaw/normalization-core/mountinfo-path";
import { z } from "zod";
import { runCommandWithTimeout } from "../process/exec.js";

type SystemDisk = { path: string; totalBytes: number; availableBytes: number };

const windowsVolumeSchema = z.object({
  Path: z.string().min(1),
  Capacity: z.number().int().positive(),
  FreeSpace: z.number().int().nonnegative(),
});
const commandOptions = { timeoutMs: 3_000, maxOutputBytes: 1024 * 1024 };
let snapshot: { expiresAt: number; pending: Promise<SystemDisk[] | undefined> } | undefined;

async function readMountedDiskPaths(platform: NodeJS.Platform): Promise<string[] | undefined> {
  if (platform === "linux") {
    const mounts = await fs.readFile("/proc/self/mountinfo", "utf8");
    const devices = new Map<string, { path: string; root: string }>();
    for (const line of mounts.split("\n")) {
      const [mount, filesystem] = line.split(" - ");
      const [device, root, encodedPath] = (mount ?? "").split(" ").slice(2, 5);
      const [type, source] = (filesystem ?? "").split(" ");
      if (!device || !root || !encodedPath || !source || type === "squashfs") {
        continue;
      }
      const mountPath = decodeMountInfoPath(encodedPath);
      // Containers expose their writable storage through overlay at /; other
      // roots must meet the same local-disk predicate as ordinary mounts.
      const localDisk = source.startsWith("/dev/") || type === "zfs";
      if (!localDisk && !(mountPath === "/" && type === "overlay")) {
        continue;
      }
      const existing = devices.get(device);
      const wholeFilesystem = root === "/";
      const existingWholeFilesystem = existing?.root === "/";
      if (
        !existing ||
        (wholeFilesystem && !existingWholeFilesystem) ||
        (wholeFilesystem === existingWholeFilesystem &&
          (mountPath.length < existing.path.length ||
            (mountPath.length === existing.path.length && mountPath < existing.path)))
      ) {
        devices.set(device, { path: mountPath, root });
      }
    }
    return [...devices.values()].map((entry) => entry.path);
  }

  const { stdout, code } = await runCommandWithTimeout(["mount"], commandOptions);
  if (code !== 0) {
    return undefined;
  }
  return stdout.split("\n").flatMap((line) => {
    const match = /^\/dev\/\S+ on (.+) \(([^)]+)\)$/.exec(line);
    if (!match) {
      return [];
    }
    const [, mountPath, flags] = match;
    return mountPath &&
      flags?.split(", ").includes("local") &&
      (mountPath === "/" || !flags.split(", ").includes("nobrowse"))
      ? [mountPath]
      : [];
  });
}

async function collectSystemDisks(): Promise<SystemDisk[] | undefined> {
  const platform = os.platform();
  if (platform === "win32") {
    const { stdout, code } = await runCommandWithTimeout(
      [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); " +
          "Get-CimInstance Win32_Volume -Filter 'DriveType=2 OR DriveType=3' | ForEach-Object { " +
          "$volume = $_; $mount = if ($volume.DriveLetter) { $volume.DriveLetter + '\\' } else { " +
          "Get-CimAssociatedInstance -InputObject $volume -Association Win32_MountPoint " +
          "-ResultClassName Win32_Directory | Select-Object -ExpandProperty Name | Sort-Object | Select-Object -First 1 }; " +
          "if ($mount) { [pscustomobject]@{Path=$mount;Capacity=$volume.Capacity;FreeSpace=$volume.FreeSpace} } " +
          "} | ConvertTo-Json -Compress",
      ],
      commandOptions,
    );
    if (code !== 0) {
      return undefined;
    }
    const parsed: unknown = stdout.trim() ? JSON.parse(stdout) : [];
    return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((row) => {
      const result = windowsVolumeSchema.safeParse(row);
      return result.success
        ? [
            {
              path: result.data.Path,
              totalBytes: result.data.Capacity,
              availableBytes: result.data.FreeSpace,
            },
          ]
        : [];
    });
  }
  if (platform !== "linux" && platform !== "darwin") {
    return undefined;
  }
  const paths = await readMountedDiskPaths(platform);
  if (!paths?.length) {
    return paths ? [] : undefined;
  }
  const { stdout, code } = await runCommandWithTimeout(["df", "-kP", ...paths], {
    ...commandOptions,
    env: { LC_ALL: "C" },
  });
  // An unmounted volume's directory can resolve to another sampled filesystem.
  // Key by the returned mount path so df's repeated rows remain one disk.
  const disks = new Map<string, SystemDisk>();
  for (const line of stdout.split("\n")) {
    const match = /^.+?\s+(\d+)\s+\d+\s+(-?\d+)\s+\d+%\s+(.+)$/.exec(line);
    if (!match) {
      continue;
    }
    const [, total, available, mountPath] = match;
    const totalBytes = Number(total) * 1024;
    const availableBytes = Math.max(0, Number(available) * 1024);
    if (
      mountPath &&
      paths.includes(mountPath) &&
      Number.isSafeInteger(totalBytes) &&
      totalBytes > 0 &&
      Number.isSafeInteger(availableBytes)
    ) {
      disks.set(mountPath, { path: mountPath, totalBytes, availableBytes });
    }
  }
  // Preserve completed rows from a partial df failure, but distinguish a
  // failed probe from successful discovery of no eligible disks.
  return code !== 0 && disks.size === 0 ? undefined : [...disks.values()];
}

export function readSystemDisks(): Promise<SystemDisk[] | undefined> {
  const now = Date.now();
  if (!snapshot || now >= snapshot.expiresAt) {
    const next = {
      expiresAt: Infinity,
      pending: collectSystemDisks()
        .then((disks) => disks?.toSorted((left, right) => left.path.localeCompare(right.path)))
        .catch(() => undefined)
        .finally(() => {
          next.expiresAt = Date.now() + 10_000;
        }),
    };
    snapshot = next;
  }
  return snapshot.pending;
}
