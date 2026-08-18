// Windows Git launcher tests cover rendering, installer creation, and Doctor migration ownership.
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { reconcileWindowsGitLauncher } from "./windows-git-launcher.js";
import { decodeWindowsLauncherScript } from "./windows-launcher-encoding.js";

const resolveNodeRuntimeInfo = vi.hoisted(() => vi.fn());

vi.mock("./node-runtime-info.js", () => ({
  resolveNodeRuntimeInfo,
}));

async function createLauncherFixture(root: string) {
  const nodePath = path.join(root, "runtime", "node.exe");
  const entryPath = path.join(root, "checkout", "dist", "entry.js");
  const launcherPath = path.join(root, "home", ".local", "bin", "openclaw.cmd");
  await fs.mkdir(path.dirname(nodePath), { recursive: true });
  await fs.mkdir(path.dirname(entryPath), { recursive: true });
  await fs.mkdir(path.dirname(launcherPath), { recursive: true });
  await fs.writeFile(nodePath, "node", "utf8");
  await fs.writeFile(entryPath, "entry", "utf8");
  return { nodePath, entryPath, launcherPath };
}

describe("reconcileWindowsGitLauncher", () => {
  beforeEach(() => {
    resolveNodeRuntimeInfo.mockReset();
    resolveNodeRuntimeInfo.mockResolvedValue({
      nodeVersion: "24.15.0",
      sqliteVersion: "3.51.3",
      nodeSharedSqlite: false,
      supported: true,
    });
  });

  it("preserves quoted CMD metacharacters and escapes expansion", async () => {
    await withTestDir(
      {
        prefix: "openclaw-windows-git-launcher-",
        subdir: "paths ^ & (approved)! %USER%",
      },
      async (root) => {
        const fixture = await createLauncherFixture(root);
        await reconcileWindowsGitLauncher({
          root,
          repair: true,
          create: true,
          platform: "win32",
          ...fixture,
        });
        const launcher = decodeWindowsLauncherScript({
          buffer: await fs.readFile(fixture.launcherPath),
        });

        expect(launcher).toContain("setlocal DisableDelayedExpansion");
        expect(launcher).toContain(fixture.nodePath.replaceAll("%", "%%"));
        expect(launcher).toContain(fixture.entryPath.replaceAll("%", "%%"));
        expect(launcher).toContain(" & (approved)!");
      },
    );
  });

  it("rejects path characters that cannot be represented in a quoted CMD argument", async () => {
    await expect(
      reconcileWindowsGitLauncher({
        root: "C:\\OpenClaw",
        repair: true,
        create: true,
        platform: "win32",
        nodePath: 'C:\\bad"path\\node.exe',
        entryPath: "C:\\OpenClaw\\dist\\entry.js",
        launcherPath: "C:\\Users\\alice\\.local\\bin\\openclaw.cmd",
      }),
    ).rejects.toThrow(/cannot contain/);
  });

  it("migrates the exact legacy PATH launcher and is then idempotent", async () => {
    await withTestDir({ prefix: "openclaw-windows-git-launcher-" }, async (root) => {
      const fixture = await createLauncherFixture(root);
      const legacy = `@echo off\r\nnode "${fixture.entryPath}" %*\r\n`;
      await fs.writeFile(
        fixture.launcherPath,
        Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(legacy, "utf16le")]),
      );

      await expect(
        reconcileWindowsGitLauncher({
          root,
          repair: false,
          platform: "win32",
          ...fixture,
        }),
      ).resolves.toEqual({ status: "needs-repair", launcherPath: fixture.launcherPath });
      expect(await fs.readFile(fixture.launcherPath)).toEqual(
        Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(legacy, "utf16le")]),
      );

      await expect(
        reconcileWindowsGitLauncher({
          root,
          repair: true,
          platform: "win32",
          ...fixture,
        }),
      ).resolves.toEqual({ status: "updated", launcherPath: fixture.launcherPath });
      const migrated = decodeWindowsLauncherScript({
        buffer: await fs.readFile(fixture.launcherPath),
      });
      expect(migrated).toContain("rem OpenClaw Git launcher");
      expect(migrated).toContain(`"${fixture.nodePath}" "${fixture.entryPath}" %*`);

      await expect(
        reconcileWindowsGitLauncher({
          root,
          repair: true,
          platform: "win32",
          ...fixture,
        }),
      ).resolves.toEqual({ status: "unchanged", launcherPath: fixture.launcherPath });

      const replacementNodePath = path.join(root, "replacement ^^ %% runtime", "node.exe");
      await fs.mkdir(path.dirname(replacementNodePath), { recursive: true });
      await fs.writeFile(replacementNodePath, "node", "utf8");
      await expect(
        reconcileWindowsGitLauncher({
          root,
          repair: true,
          platform: "win32",
          ...fixture,
          nodePath: replacementNodePath,
        }),
      ).resolves.toEqual({ status: "updated", launcherPath: fixture.launcherPath });
      expect(
        decodeWindowsLauncherScript({ buffer: await fs.readFile(fixture.launcherPath) }),
      ).toContain("replacement ^^ %%%% runtime");
      await expect(
        reconcileWindowsGitLauncher({
          root,
          repair: true,
          platform: "win32",
          ...fixture,
          nodePath: replacementNodePath,
        }),
      ).resolves.toEqual({ status: "unchanged", launcherPath: fixture.launcherPath });
    });
  });

  it("repairs the installer-owned USERPROFILE launcher when HOME differs", async () => {
    await withTestDir({ prefix: "openclaw-windows-git-launcher-" }, async (root) => {
      const fixture = await createLauncherFixture(root);
      const userProfile = path.join(root, "windows-profile");
      const shellHome = path.join(root, "git-bash-home");
      const launcherPath = path.join(userProfile, ".local", "bin", "openclaw.cmd");
      const legacy = `@echo off\r\nnode "${fixture.entryPath}" %*\r\n`;
      await fs.mkdir(path.dirname(launcherPath), { recursive: true });
      await fs.writeFile(launcherPath, legacy, "utf8");

      await expect(
        reconcileWindowsGitLauncher({
          root,
          repair: true,
          platform: "win32",
          env: { HOME: shellHome, USERPROFILE: userProfile },
          nodePath: fixture.nodePath,
          entryPath: fixture.entryPath,
        }),
      ).resolves.toEqual({ status: "updated", launcherPath });
      expect(decodeWindowsLauncherScript({ buffer: await fs.readFile(launcherPath) })).toContain(
        "rem OpenClaw Git launcher",
      );
      await expect(
        fs.stat(path.join(shellHome, ".local", "bin", "openclaw.cmd")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("leaves a legacy launcher unchanged when the selected runtime is unsupported", async () => {
    await withTestDir({ prefix: "openclaw-windows-git-launcher-" }, async (root) => {
      const fixture = await createLauncherFixture(root);
      const legacy = `@echo off\r\nnode "${fixture.entryPath}" %*\r\n`;
      await fs.writeFile(fixture.launcherPath, legacy, "utf8");
      resolveNodeRuntimeInfo.mockResolvedValue({
        nodeVersion: "24.14.0",
        sqliteVersion: "3.51.2",
        nodeSharedSqlite: false,
        supported: false,
      });

      await expect(
        reconcileWindowsGitLauncher({
          root,
          repair: true,
          platform: "win32",
          ...fixture,
        }),
      ).resolves.toEqual({ status: "needs-reinstall", launcherPath: fixture.launcherPath });
      await expect(fs.readFile(fixture.launcherPath, "utf8")).resolves.toBe(legacy);
    });
  });

  it("creates a missing launcher only for the installer path", async () => {
    await withTestDir({ prefix: "openclaw-windows-git-launcher-" }, async (root) => {
      const fixture = await createLauncherFixture(root);

      await expect(
        reconcileWindowsGitLauncher({
          root,
          repair: true,
          platform: "win32",
          ...fixture,
        }),
      ).resolves.toEqual({ status: "skipped", reason: "missing" });
      await expect(fs.stat(fixture.launcherPath)).rejects.toMatchObject({ code: "ENOENT" });

      await expect(
        reconcileWindowsGitLauncher({
          root,
          repair: true,
          create: true,
          platform: "win32",
          ...fixture,
        }),
      ).resolves.toEqual({ status: "created", launcherPath: fixture.launcherPath });
    });
  });

  it("does not replace an unrelated custom launcher", async () => {
    await withTestDir({ prefix: "openclaw-windows-git-launcher-" }, async (root) => {
      const fixture = await createLauncherFixture(root);
      const custom = [
        "@echo off",
        "rem OpenClaw Git launcher",
        "echo custom launcher",
        `"${fixture.nodePath}" "${fixture.entryPath}" %*`,
        "",
      ].join("\r\n");
      await fs.writeFile(fixture.launcherPath, custom, "utf8");

      await expect(
        reconcileWindowsGitLauncher({
          root,
          repair: true,
          create: true,
          platform: "win32",
          ...fixture,
        }),
      ).resolves.toEqual({ status: "skipped", reason: "foreign" });
      await expect(fs.readFile(fixture.launcherPath, "utf8")).resolves.toBe(custom);

      const doubledPercentEntryPath = path.join(root, "literal %% checkout", "dist", "entry.js");
      const malformedManagedLauncher = [
        "@echo off",
        "rem OpenClaw Git launcher",
        "setlocal DisableDelayedExpansion",
        `if exist "${fixture.nodePath}" goto openclaw_runtime_ready`,
        "echo [!] OpenClaw's validated Node.js runtime is missing. 1>&2",
        "echo [i] Re-run the OpenClaw installer to repair this Git installation. 1>&2",
        "exit /b 1",
        ":openclaw_runtime_ready",
        `"${fixture.nodePath}" "${doubledPercentEntryPath}" %*`,
        "",
      ].join("\r\n");
      await fs.writeFile(fixture.launcherPath, malformedManagedLauncher, "utf8");

      await expect(
        reconcileWindowsGitLauncher({
          root,
          repair: true,
          create: true,
          platform: "win32",
          ...fixture,
          entryPath: doubledPercentEntryPath,
        }),
      ).resolves.toEqual({ status: "skipped", reason: "foreign" });
      await expect(fs.readFile(fixture.launcherPath, "utf8")).resolves.toBe(
        malformedManagedLauncher,
      );
    });
  });

  it("does nothing outside Windows", async () => {
    await expect(
      reconcileWindowsGitLauncher({
        root: "/tmp/openclaw",
        repair: true,
        platform: "linux",
      }),
    ).resolves.toEqual({ status: "skipped", reason: "not-windows" });
  });
});
