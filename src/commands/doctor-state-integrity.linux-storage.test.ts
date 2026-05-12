import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectLinuxSdBackedStateDir,
  formatLinuxSdBackedStateDirWarning,
} from "./doctor-state-integrity.js";

function encodeMountInfoPath(value: string): string {
  return value
    .replace(/\\/g, "\\134")
    .replace(/\n/g, "\\012")
    .replace(/\t/g, "\\011")
    .replace(/ /g, "\\040");
}

describe("detectLinuxSdBackedStateDir", () => {
  it("detects state dir on mmc-backed mount", () => {
    const mountInfo = [
      "24 19 179:2 / / rw,relatime - ext4 /dev/mmcblk0p2 rw",
      "25 24 0:22 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw",
    ].join("\n");

    const result = detectLinuxSdBackedStateDir("/home/pi/.openclaw", {
      platform: "linux",
      mountInfo,
    });

    expect(result).toEqual({
      path: "/home/pi/.openclaw",
      mountPoint: "/",
      fsType: "ext4",
      source: "/dev/mmcblk0p2",
    });
  });

  it("returns null for non-mmc devices", () => {
    const mountInfo = "24 19 259:2 / / rw,relatime - ext4 /dev/nvme0n1p2 rw";

    const result = detectLinuxSdBackedStateDir("/home/user/.openclaw", {
      platform: "linux",
      mountInfo,
    });

    expect(result).toBeNull();
  });

  it("resolves /dev/disk aliases to mmc devices", () => {
    const mountInfo = "24 19 179:2 / / rw,relatime - ext4 /dev/disk/by-uuid/abcd-1234 rw";

    const result = detectLinuxSdBackedStateDir("/home/user/.openclaw", {
      platform: "linux",
      mountInfo,
      resolveDeviceRealPath: (devicePath) => {
        if (devicePath === "/dev/disk/by-uuid/abcd-1234") {
          return "/dev/mmcblk0p2";
        }
        return null;
      },
    });

    expect(result).toEqual({
      path: "/home/user/.openclaw",
      mountPoint: "/",
      fsType: "ext4",
      source: "/dev/disk/by-uuid/abcd-1234",
    });
  });

  it("uses resolved state path to select mount", () => {
    const mountInfo = [
      "24 19 259:2 / / rw,relatime - ext4 /dev/nvme0n1p2 rw",
      "30 24 179:5 / /mnt/slow rw,relatime - ext4 /dev/mmcblk1p1 rw",
    ].join("\n");

    const result = detectLinuxSdBackedStateDir("/tmp/openclaw-state", {
      platform: "linux",
      mountInfo,
      resolveRealPath: () => "/mnt/slow/openclaw/.openclaw",
    });

    expect(result).toEqual({
      path: "/mnt/slow/openclaw/.openclaw",
      mountPoint: "/mnt/slow",
      fsType: "ext4",
      source: "/dev/mmcblk1p1",
    });
  });

  it("returns null outside linux", () => {
    const mountInfo = "24 19 179:2 / / rw,relatime - ext4 /dev/mmcblk0p2 rw";

    const result = detectLinuxSdBackedStateDir(path.join("/Users", "tester", ".openclaw"), {
      platform: "darwin",
      mountInfo,
    });

    expect(result).toBeNull();
  });

  it("escapes decoded mountinfo control characters in warning output", () => {
    const mountRoot = "/home/pi/mnt\nspoofed";
    const stateDir = `${mountRoot}/.openclaw`;
    const encodedSource = "/dev/disk/by-uuid/mmc\\012source";
    const mountInfo = `30 24 179:2 / ${encodeMountInfoPath(mountRoot)} rw,relatime - ext4 ${encodedSource} rw`;

    const result = detectLinuxSdBackedStateDir(stateDir, {
      platform: "linux",
      mountInfo,
      resolveRealPath: () => stateDir,
      resolveDeviceRealPath: (devicePath) => {
        if (devicePath === "/dev/disk/by-uuid/mmc\nsource") {
          return "/dev/mmcblk0p2";
        }
        return null;
      },
    });

    if (result === null) {
      throw new Error("Expected Linux state storage warning details");
    }
    const warning = formatLinuxSdBackedStateDirWarning(stateDir, result);
    expect(warning).toContain("device /dev/disk/by-uuid/mmc\\nsource");
    expect(warning).toContain("mount /home/pi/mnt\\nspoofed");
    expect(warning).not.toContain("device /dev/disk/by-uuid/mmc\nsource");
    expect(warning).not.toContain("mount /home/pi/mnt\nspoofed");
  });
});
