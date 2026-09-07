import * as childProcess from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn(actual.execFile),
    execFileSync: vi.fn(actual.execFileSync),
  };
});

import {
  createPrivateSqliteDirectory,
  createPrivateSqliteTempDirectorySync,
} from "./sqlite-private-directory.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.runIf(process.platform === "win32")("private SQLite directory creation on Windows", () => {
  afterEach(() => vi.clearAllMocks());

  it("creates protected directories without spawning PowerShell or a compiler", async () => {
    const root = tempDirs.make("openclaw-sqlite-private-directory-");
    const asyncPath = path.join(root, "private 测试");
    await createPrivateSqliteDirectory(asyncPath);
    const syncPath = createPrivateSqliteTempDirectorySync(root, "sync-");
    expect(childProcess.execFile).not.toHaveBeenCalled();
    expect(childProcess.execFileSync).not.toHaveBeenCalled();

    for (const directory of [asyncPath, syncPath]) {
      const script = [
        `$acl = [IO.Directory]::GetAccessControl('${directory.replaceAll("'", "''")}')`,
        "$user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
        "$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))",
        "@{ protected = $acl.AreAccessRulesProtected; owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; user = $user; rules = @($rules | ForEach-Object { @{ sid = $_.IdentityReference.Value; rights = [int]$_.FileSystemRights; inheritance = [int]$_.InheritanceFlags; inherited = $_.IsInherited; allow = [int]$_.AccessControlType } }) } | ConvertTo-Json -Depth 4 -Compress",
      ].join("; ");
      const acl = JSON.parse(
        childProcess.execFileSync(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", script],
          {
            encoding: "utf8",
          },
        ),
      );
      expect(acl.protected).toBe(true);
      expect(acl.owner).toBe(acl.user);
      expect(acl.rules.map((rule: { sid: string }) => rule.sid).toSorted()).toEqual(
        [acl.user, "S-1-5-18", "S-1-5-32-544"].toSorted((left, right) => left.localeCompare(right)),
      );
      for (const rule of acl.rules) {
        expect(rule).toMatchObject({ rights: 2032127, inheritance: 3, inherited: false, allow: 0 });
      }
      await fs.writeFile(path.join(directory, "synthetic.sqlite"), "synthetic");
      const listing = childProcess.execFileSync("icacls.exe", [directory], { encoding: "utf8" });
      expect(listing).toContain("(OI)(CI)(F)");
      expect(listing).not.toContain("(I)");
    }
  });

  it("rejects concurrent creation, existing files, and junctions without modifying them", async () => {
    const root = tempDirs.make("openclaw-sqlite-private-existing-");
    const directory = path.join(root, "private");
    const attempts = await Promise.allSettled([
      createPrivateSqliteDirectory(directory),
      createPrivateSqliteDirectory(directory),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.find((attempt) => attempt.status === "rejected")).toMatchObject({
      reason: { code: "EEXIST" },
    });
    const file = path.join(root, "file");
    await fs.writeFile(file, "keep");
    const junction = path.join(root, "junction");
    await fs.symlink(directory, junction, "junction");
    for (const existing of [file, junction]) {
      await expect(createPrivateSqliteDirectory(existing)).rejects.toMatchObject({
        code: "EEXIST",
      });
    }
    expect(await fs.readFile(file, "utf8")).toBe("keep");
    expect((await fs.lstat(junction)).isSymbolicLink()).toBe(true);
  });

  it("reports native failure when the parent is a regular file", async () => {
    const root = tempDirs.make("openclaw-sqlite-private-failure-");
    const regularFile = path.join(root, "parent-file");
    await fs.writeFile(regularFile, "not a directory");
    await expect(createPrivateSqliteDirectory(path.join(regularFile, "child"))).rejects.toThrow(
      /CreateDirectoryW.*Win32 error/u,
    );
  });
});
