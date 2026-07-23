import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  applyPluginUninstallDirectoryRemoval,
  prepareConfigForPendingPluginDirectoryRemoval,
} from "./uninstall.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("plugin uninstall directory removal", () => {
  it("removes owned channel config before disabling a plugin for directory removal", () => {
    expect(
      prepareConfigForPendingPluginDirectoryRemoval(
        {
          channels: {
            "demo-channel": { enabled: true },
            telegram: { enabled: true },
          },
          plugins: { entries: { "demo-plugin": { enabled: true } } },
        },
        "demo-plugin",
        { channelIds: ["demo-channel"] },
      ),
    ).toEqual({
      channels: { telegram: { enabled: true } },
      plugins: { entries: { "demo-plugin": { enabled: false } } },
    });
  });

  it("removes a dangling managed-target symlink", async () => {
    const root = tempDirs.make("openclaw-plugin-uninstall-");
    const target = path.join(root, "plugin");
    await fs.symlink(path.join(root, "missing-target"), target, "dir");

    await expect(fs.lstat(target)).resolves.toBeDefined();
    await expect(applyPluginUninstallDirectoryRemoval({ target })).resolves.toEqual({
      directoryRemoved: true,
      warnings: [],
    });
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
