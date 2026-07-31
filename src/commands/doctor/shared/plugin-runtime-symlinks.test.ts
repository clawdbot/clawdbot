// Plugin runtime symlink tests cover doctor detection of stale global symlinks.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectStalePluginRuntimeSymlinkHealthFindings } from "./plugin-runtime-symlinks.js";

async function expectSymlinkPresent(targetPath: string): Promise<void> {
  expect((await fs.lstat(targetPath)).isSymbolicLink()).toBe(true);
}

async function canCreateDirectorySymlink(root: string): Promise<boolean> {
  const target = path.join(root, "symlink-capability-target");
  const link = path.join(root, "symlink-capability-link");
  await fs.mkdir(target, { recursive: true });
  try {
    await fs.symlink(target, link, "dir");
    return (await fs.lstat(link)).isSymbolicLink();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
      return false;
    }
    throw error;
  } finally {
    await fs.rm(link, { recursive: true, force: true });
    await fs.rm(target, { recursive: true, force: true });
  }
}

describe("plugin runtime symlink health findings", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-runtime-symlinks-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("maps dangling plugin-runtime symlinks to read-only lint findings", async () => {
    if (!(await canCreateDirectorySymlink(tempDir))) {
      return;
    }

    const packageRoot = path.join(tempDir, "prefix", "lib", "node_modules", "openclaw");
    const nodeModulesRoot = path.dirname(packageRoot);
    const legacyRoot = path.join(tempDir, "state", "plugin-runtime-deps");
    const missingTarget = path.join(
      legacyRoot,
      "openclaw-slack",
      "node_modules",
      "@slack",
      "web-api",
    );
    const scopeRoot = path.join(nodeModulesRoot, "@slack");
    const staleLink = path.join(scopeRoot, "web-api");
    const liveTarget = path.join(tempDir, "live", "@slack", "bolt");
    const liveLink = path.join(scopeRoot, "bolt");

    await fs.mkdir(packageRoot, { recursive: true });
    await fs.mkdir(scopeRoot, { recursive: true });
    await fs.mkdir(liveTarget, { recursive: true });
    await fs.symlink(missingTarget, staleLink, "dir");
    await fs.symlink(liveTarget, liveLink, "dir");

    expect(await collectStalePluginRuntimeSymlinkHealthFindings({ packageRoot })).toEqual([
      {
        checkId: "core/doctor/stale-plugin-runtime-symlinks",
        severity: "warning",
        message: `Stale plugin-runtime symlink @slack/web-api points at ${missingTarget}.`,
        path: staleLink,
        target: staleLink,
        requirement: "stale-plugin-runtime-symlink-removed",
        fixHint: "Run `openclaw doctor --fix` to remove stale plugin-runtime symlinks.",
      },
    ]);
    await expectSymlinkPresent(staleLink);
    await expectSymlinkPresent(liveLink);
  });

  it("reports symlinks that point inside classified stale roots", async () => {
    if (!(await canCreateDirectorySymlink(tempDir))) {
      return;
    }

    const packageRoot = path.join(tempDir, "prefix", "lib", "node_modules", "openclaw");
    const nodeModulesRoot = path.dirname(packageRoot);
    const legacyRoot = path.join(tempDir, "state", "plugin-runtime-deps");
    const existingTarget = path.join(legacyRoot, "openclaw-demo", "node_modules", "left-pad");
    const staleLink = path.join(nodeModulesRoot, "left-pad");

    await fs.mkdir(packageRoot, { recursive: true });
    await fs.mkdir(existingTarget, { recursive: true });
    await fs.symlink(existingTarget, staleLink, "dir");

    await expect(collectStalePluginRuntimeSymlinkHealthFindings({ packageRoot })).resolves.toEqual(
      [],
    );
    await expect(
      collectStalePluginRuntimeSymlinkHealthFindings({
        packageRoot,
        staleRoots: [legacyRoot],
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        checkId: "core/doctor/stale-plugin-runtime-symlinks",
        path: staleLink,
        target: staleLink,
      }),
    ]);
    await expectSymlinkPresent(staleLink);
  });
});
